// V1 plugin implementation (OpenCode >= 1.18.29 object entrypoints).
// Exposed as `server()` on the combined entrypoint in index.js; V1 calls it
// with the classic `{ client }` argument.
import { mkdirSync, existsSync, unlinkSync, copyFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { tool } from "@opencode-ai/plugin/tool"

import {
  loadSession,
  saveSession,
  deleteSession,
  resolveWorktreeWorkspace,
  runWithTimeout,
} from "./helpers.js"

import {
  executeDevcontainerTool,
  executeDevcontainerExecTool,
  cleanupStaleSessions,
  interceptShellCommand,
} from "./handlers.js"

import {
  isWorktree,
  getRepoRoot,
  createWorktreeWorkspace,
  listAllWorkspaces,
  getWorkspaceStatus,
  findStaleWorkspaces,
  formatWorkspace,
  cleanupJobs,
} from "./core/index.js"

// Timeout for init operations (2 seconds)
const INIT_TIMEOUT_MS = 2000

const __dirname = dirname(fileURLToPath(import.meta.url))

// ============ Internal Functions ============

/**
 * Install the V1 command files (/devcontainer, /worktree, /workspaces)
 * into the user's config directory if they are missing or stale.
 * Runs fire-and-forget at init (slow API calls must not block startup).
 *
 * @param {object} client - OpenCode V1 SDK client
 */
async function installCommands(client) {
  try {
    const paths = await client.path.get()
    const configDir = paths.data?.config
    if (!configDir) return
    
    const commandDir = join(configDir, "command")
    mkdirSync(commandDir, { recursive: true })
    
    // Install all command files
    const commands = ["devcontainer.md", "worktree.md", "workspaces.md"]
    for (const cmd of commands) {
      const sourceFile = join(__dirname, "command", cmd)
      const destFile = join(commandDir, cmd)
      if (existsSync(sourceFile)) {
        copyFileSync(sourceFile, destFile)
      }
    }
    
    // Clean up old command file names
    const oldFiles = ["ocdc-use.md", "ocdc.md"]
    for (const oldName of oldFiles) {
      const oldFile = join(commandDir, oldName)
      if (existsSync(oldFile)) {
        unlinkSync(oldFile)
      }
    }
  } catch {}
}

/** Fetch workspace statuses in parallel (read-only) */
async function withStatuses(workspaces) {
  return Promise.all(
    workspaces.map(async (ws) => ({ ws, status: await getWorkspaceStatus(ws.workspace) }))
  )
}

/** Status text for the worktree tool (no target given) */
function worktreeStatusText(session) {
  if (!session) {
    return "No workspace active for this session.\n\n" +
           "Use `/worktree <branch>` to create/target a worktree."
  }

  if (session.type !== "worktree") {
    return `Current session is targeting a devcontainer, not a worktree.\n` +
           `Use \`/devcontainer\` to check devcontainer status, or \`/devcontainer off\` first.`
  }

  return `Current worktree: ${session.repoName}/${session.branch}\n` +
         `Workspace: ${session.workspace}\n` +
         `Main repo: ${session.mainRepo}\n` +
         `\nAll bash commands will run in this worktree directory.\n` +
         `Use \`/worktree off\` to disable.`
}

// ============ Plugin Export ============

/**
 * V1 plugin entrypoint (function-with-attached-server shape, OpenCode
 * >= 1.18.29). Registers command files, tools, and the shell
 * interception hook against the V1 SDK client.
 *
 * @param {{ client: object }} ctx - V1 plugin context
 * @returns {{ server: () => Promise<void> }} Server accessor for older V1 loaders
 */
export const devcontainers = async ({ client }) => {
  // Install command files if needed (don't block on slow API)
  void runWithTimeout(() => installCommands(client), INIT_TIMEOUT_MS)
  
  // Cleanup stale sessions (don't block on slow API)
  void runWithTimeout(
    () => cleanupStaleSessions(async () => {
      // The V1 SDK can return { error } without throwing — treat any
      // non-array shape as "skip cleanup" rather than "delete everything"
      const listed = await client.session.list()
      const sessions = listed?.data
      if (!Array.isArray(sessions)) {
        throw new TypeError("unexpected session.list() shape; skipping stale-session cleanup")
      }
      return sessions.map(s => s.id)
    }),
    INIT_TIMEOUT_MS
  )
  
  // Cleanup old jobs (don't block)
  void runWithTimeout(() => cleanupJobs(), INIT_TIMEOUT_MS)
  
  return {
    tool: {
      // Execute command in devcontainer
      devcontainer_exec: tool({
        description: "Execute a command in the current devcontainer context. IMPORTANT: Only use this tool when a devcontainer session is active (set via /devcontainer command). For normal shell commands, use the bash tool instead.",
        args: {
          command: tool.schema.string().describe("Command to execute"),
        },
        async execute(args, ctx) {
          return executeDevcontainerExecTool(args, {
            sessionID: ctx.sessionID,
            signal: ctx.abort,
          })
        }
      }),
      
      // Interactive command for manual devcontainer targeting
      devcontainer: tool({
        description: "Set active devcontainer for this session. Use 'off' to disable. Set create=true to create a new workspace if it doesn't exist.",
        args: {
          target: tool.schema.string().optional().describe(
            "Branch name (e.g., 'feature-x'), 'off' to disable, or empty for status"
          ),
          create: tool.schema.string().optional().describe(
            "Set to 'true' to create the workspace if it doesn't exist (requires confirmation)"
          ),
          confirmed: tool.schema.boolean().optional().describe(
            "Set to true to confirm the remove operation after reviewing warnings about uncommitted changes or other active sessions"
          ),
        },
        async execute(args, ctx) {
          return executeDevcontainerTool(args, {
            sessionID: ctx.sessionID,
            signal: ctx.abort,
          })
        }
      }),
      
      // Interactive command for manual worktree targeting
      worktree: tool({
        description: "Set active git worktree for this session. Use 'off' to disable. Worktrees provide isolated branch work without devcontainers.",
        args: {
          target: tool.schema.string().optional().describe(
            "Branch name (e.g., 'feature-x'), 'off' to disable, or empty for status"
          ),
          workdir: tool.schema.string().optional().describe(
            "Working directory (git repository) to create worktree from. Defaults to current directory."
          ),
        },
        async execute(args, ctx) {
          const { sessionID } = ctx
          const { target, workdir } = args
          const cwd = workdir || process.cwd()
          
          // Status request (no target)
          if (!target || target.trim() === "") {
            return worktreeStatusText(loadSession(sessionID))
          }
          
          // Disable request
          if (target === "off") {
            const session = loadSession(sessionID)
            deleteSession(sessionID)
            if (session?.type === "worktree") {
              return `Worktree mode disabled. Commands will now run in the current directory.`
            }
            if (session) {
              return `Session was targeting a devcontainer, not a worktree. Session cleared.`
            }
            return "No workspace was active for this session."
          }
          
          // Check if we're in a git repo
          const repoRoot = await getRepoRoot(cwd)
          
          if (!repoRoot) {
            return `Not in a git repository (checked: ${cwd}).\n\n` +
                   `Please call this tool with the \`workdir\` parameter set to the project directory.\n` +
                   `Example: worktree(target: "${target}", workdir: "/path/to/your/repo")`
          }
          
          // Check if already in a worktree
          if (await isWorktree(repoRoot)) {
            return `Already in a worktree.\n\n` +
                   `Create new worktrees from the main repository, not from within another worktree.`
          }
          
          // Check if worktree already exists
          const resolved = resolveWorktreeWorkspace(target)
          
          if (resolved && !resolved.ambiguous) {
            const { workspace, repoName, branch, mainRepo } = resolved
            
            // Save session state
            saveSession(sessionID, {
              type: "worktree",
              branch,
              workspace,
              repoName,
              mainRepo,
            })
            
            return `Session now targeting worktree: ${repoName}/${branch}\n` +
                   `Workspace: ${workspace}\n\n` +
                   `All bash commands will run in this worktree directory.\n` +
                   `Use \`/worktree off\` to disable, or prefix with \`HOST:\` to run in original directory.`
          }
          
          if (resolved?.ambiguous) {
            const options = resolved.matches
              .map(m => `  - ${m.repo}/${m.branch}`)
              .join("\n")
            return `Ambiguous branch '${target}' found in multiple repos:\n${options}\n\n` +
                   `Use \`/worktree <repo>/${target}\` to specify.`
          }
          
          // Create new worktree
          try {
            const result = await createWorktreeWorkspace({
              repoRoot,
              branch: target,
            })
            
            saveSession(sessionID, {
              type: "worktree",
              branch: result.branch,
              workspace: result.workspace,
              repoName: result.repoName,
              mainRepo: result.mainRepo,
            })
            
            return `Created worktree for ${result.repoName}/${result.branch}\n` +
                   `Workspace: ${result.workspace}\n\n` +
                   `All bash commands will run in this worktree directory.\n` +
                   `Gitignored files (secrets, .env) have been copied from main repo.\n` +
                   `Use \`/worktree off\` to disable.`
          } catch (err) {
            return `Failed to create worktree: ${err.message}`
          }
        }
      }),
      
      // Workspace management tool
      workspaces: tool({
        description: "List and manage workspaces (worktrees and devcontainer clones). Use 'cleanup' to find stale workspaces.",
        args: {
          action: tool.schema.string().optional().describe(
            "'cleanup' to identify stale workspaces, or empty to list all"
          ),
        },
        async execute(args, ctx) {
          const { action } = args
          
          if (action === 'cleanup') {
            // Find stale workspaces
            const stale = await findStaleWorkspaces({ maxAgeDays: 7 })
            
            if (stale.length === 0) {
              return `No stale workspaces found.\n\n` +
                     `All workspaces have been accessed within the last 7 days.`
            }
            
            let output = `Found ${stale.length} stale workspace(s) (not accessed in 7+ days):\n\n`
            
            for (const { ws, status } of await withStatuses(stale)) {
              output += formatWorkspace(ws, status) + '\n'
              output += `  Path: ${ws.workspace}\n`
              if (ws.hasUncommitted) {
                output += `  ⚠️  Has uncommitted changes!\n`
              }
              output += '\n'
            }
            
            output += `To remove a workspace:\n`
            output += `- Worktrees: \`git worktree remove <path>\` from main repo\n`
            output += `- Clones: \`rm -rf <path>\` (and stop any running containers)\n`
            
            return output
          }
          
          // Default: list all workspaces
          const workspaces = await listAllWorkspaces()
          
          if (workspaces.length === 0) {
            return `No workspaces found.\n\n` +
                   `Use \`/devcontainer <branch>\` to create a devcontainer clone, or\n` +
                   `Use \`/worktree <branch>\` to create a worktree.`
          }
          
          let output = `Found ${workspaces.length} workspace(s):\n\n`
          
          // Group by type
          const clones = workspaces.filter(w => w.type === 'clone')
          const worktrees = workspaces.filter(w => w.type === 'worktree')
          
          if (clones.length > 0) {
            output += `**Devcontainer Clones** (${clones.length}):\n`
            for (const { ws, status } of await withStatuses(clones)) {
              output += `  ${formatWorkspace(ws, status)}\n`
            }
            output += '\n'
          }
          
          if (worktrees.length > 0) {
            output += `**Worktrees** (${worktrees.length}):\n`
            for (const { ws, status } of await withStatuses(worktrees)) {
              output += `  ${formatWorkspace(ws, status)}\n`
            }
            output += '\n'
          }
          
          output += `Use \`/workspaces cleanup\` to find stale workspaces.`
          
          return output
        }
      }),
    },
    
    // Intercept bash commands to run in workspace
    "tool.execute.before": async (input, output) => {
      const result = await interceptShellCommand({
        tool: input.tool,
        sessionID: input.sessionID,
        command: output.args?.command,
        workdir: output.args?.workdir,
      })
      if (!result) return
      if (result.command !== undefined) output.args.command = result.command
      if (result.workdir !== undefined) output.args.workdir = result.workdir
    }
  }
}

// Default export for direct (function-style) V1 loading
export default devcontainers
