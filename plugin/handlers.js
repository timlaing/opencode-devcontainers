// Shared handler logic used by both the V1 (server()) and V2 (setup()) plugin
// entrypoints. Everything here is pure Node — no dependency on either plugin
// API — so behavior stays identical across OpenCode versions.
import { existsSync, readdirSync, unlinkSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  loadSession,
  saveSession,
  deleteSession,
  resolveWorkspace,
  shouldRunOnHost,
  getSessionsDir,
  shellQuote,
  isInside,
  invalidateSessionCache,
  saveSessionIfCurrent,
} from "./helpers.js"

import {
  upBackground,
  exec,
  isContainerRunning,
  checkDevcontainerCli,
  getOverridePath,
  getJob,
  JOB_STATUS,
  remove,
  listClones,
  readPorts,
  readJobs,
  getWorkspaceStatus,
} from "./core/index.js"

/**
 * Remove session files for sessions that no longer exist in the running
 * OpenCode instance. `isActive(sessionID)` resolves `true` for a live
 * session, `false` for one confirmed absent (V1 adapts `session.list`,
 * V2 probes with `ctx.session.get`), and throws to abort — any error
 * aborts cleanup, so an unconfirmed check never deletes a file. Each
 * candidate is checked immediately before unlinking, so a session saved
 * concurrently cannot be treated as stale.
 *
 * @param {(sessionID: string) => Promise<boolean>} isActive - liveness check
 * @returns {Promise<void>}
 */
export async function cleanupStaleSessions(isActive) {
  const sessionsDir = getSessionsDir()
  if (!existsSync(sessionsDir)) return

  try {
    const candidates = readdirSync(sessionsDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => ({ file, sessionID: file.replace(".json", "") }))

    // Sequential via a promise chain.
    await candidates.reduce(async (prev, { file, sessionID }) => {
      await prev
      if (await isActive(sessionID)) return
      unlinkSync(join(sessionsDir, file))
    }, Promise.resolve())
  } catch {}
}

/**
 * Build devcontainer exec command string for shell interception
 *
 * @param {string} workspace - Workspace path (will be shell-quoted)
 * @param {string} command - Command to execute (passed verbatim to shell)
 * @returns {string} Shell command string
 */
export function buildDevcontainerExecCommand(workspace, command) {
  const overridePath = getOverridePath(workspace)
  const hasOverride = existsSync(overridePath)

  let cmd = `devcontainer exec --workspace-folder ${shellQuote(workspace)}`
  if (hasOverride) {
    cmd += ` --override-config ${shellQuote(overridePath)}`
  }
  cmd += ` -- ${command}`

  return cmd
}

/**
 * Format a single remove result for display
 */
export function formatRemoveSummary(summary) {
  const label = `${summary.repo}/${summary.branch}`
  let output = `Removed devcontainer: ${label}\n`

  if (summary.containerFound) {
    output += `  - Container: ${summary.containerStopped ? "stopped and " : ""}removed\n`
    if (summary.imageRemoved) {
      output += `  - Image: removed\n`
    } else if (summary.containerFound) {
      output += `  - Image: could not remove (may be in use)\n`
    }
  } else {
    output += `  - Container: not found\n`
  }

  output += `  - Port: ${summary.portReleased ? "released" : "error"}\n`
  output += `  - Job entry: ${summary.jobRemoved !== false ? "cleaned up" : "not found"}\n`
  output += `  - Override config: ${summary.overrideDeleted ? "deleted" : "error"}\n`
  output += `  - Clone folder: ${summary.cloneDeleted ? "deleted" : "not found"}\n`

  if (summary.sessionsCleaned > 0) {
    output += `  - Sessions: ${summary.sessionsCleaned} cleaned up\n`
  }

  if (summary.errors.length > 0) {
    output += `  Errors:\n`
    for (const err of summary.errors) {
      output += `    - ${err}\n`
    }
  }

  return output
}

/**
 * Count other sessions (excluding current) that reference a workspace.
 * If workspace is null, counts all other sessions regardless of workspace.
 */
export function countOtherSessions(workspace, currentSessionID) {
  const sessionsDir = getSessionsDir()
  if (!existsSync(sessionsDir)) return 0
  const files = readdirSync(sessionsDir)
  let count = 0
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    const sid = file.replace('.json', '')
    if (sid === currentSessionID) continue
    try {
      const data = JSON.parse(readFileSync(join(sessionsDir, file), 'utf-8'))
      if (workspace === null || data.workspace === workspace) count++
    } catch {}
  }
  return count
}

/**
 * Handle `/devcontainer rm <branch>` for a single devcontainer.
 *
 * Resolves the target, surfaces pre-removal warnings (uncommitted changes,
 * other active sessions) unless already confirmed, then removes the
 * container, image, port allocation, clone, and session state.
 *
 * @param {string} rmArg - Branch name or `repo/branch` target
 * @param {string} sessionID - Session requesting the removal
 * @param {boolean} [confirmed] - Skip warnings when the user confirmed
 * @returns {Promise<string>} User-facing result or warning message
 */
export async function handleRemoveSingle(rmArg, sessionID, confirmed) {
  // Try to resolve workspace from branch name
  const resolved = resolveWorkspace(rmArg)

  if (!resolved) {
    return `No devcontainer found for branch '${rmArg}'.\n\n` +
           `Use \`/devcontainer\` to list active devcontainers or \`/devcontainer <branch>\` to set one up first.`
  }

  if (resolved.ambiguous) {
    const options = resolved.matches
      .map(m => `  - ${m.repoName}/${m.branch}`)
      .join("\n")
    return `Ambiguous branch '${rmArg}' found in multiple repos:\n${options}\n\n` +
           `Use \`/devcontainer rm <repo>/${rmArg}\` to specify.`
  }

  const { workspace, repoName, branch } = resolved

  // Pre-removal warnings (skip when already confirmed)
  if (!confirmed) {
    const msgs = []

    try {
      const status = await getWorkspaceStatus(workspace)
      if (status.hasUncommitted) msgs.push("There are uncommitted changes in the workspace.")
    } catch {}

    if (countOtherSessions(workspace, sessionID) > 0) {
      msgs.push("This workspace is active in other sessions.")
    }

    if (msgs.length > 0) {
      return msgs.join('\n') + '\n\nAn explicit user confirmation required, it is non-negotiable.'
    }
  }

  // Run the remove operation
  const summary = await remove(workspace, repoName, branch)

  // Drop cached session state for this workspace — core cleanup removes
  // session files, but the in-process cache would keep routing commands
  invalidateSessionCache(workspace)

  // Clear current session if it targets this workspace
  const session = loadSession(sessionID)
  if (session && session.workspace === workspace) {
    deleteSession(sessionID)
  }

  return formatRemoveSummary(summary)
}

/** Collect all tracked devcontainer workspaces from all sources */
async function collectRemoveAllEntries() {
  const seen = new Set()
  const entries = []

  const add = (workspace, repo, branch) => {
    if (seen.has(workspace)) return
    seen.add(workspace)
    entries.push({ workspace, repo, branch })
  }

  // From clones directory
  for (const c of await listClones()) {
    add(c.workspace, c.repo, c.branch)
  }

  // From ports.json (orphan entries not already covered)
  const ports = await readPorts()
  for (const [ws, data] of Object.entries(ports)) {
    add(ws, data.repo, data.branch)
  }

  // From jobs.json (orphan entries not already covered)
  const jobs = await readJobs()
  for (const [ws, data] of Object.entries(jobs)) {
    add(ws, data.repo, data.branch)
  }

  return entries
}

/** Pre-removal warnings for `rm all` (read-only status checks) */
async function removeAllWarnings(entries, sessionID) {
  const statuses = await Promise.all(
    entries.map(async (entry) => {
      try {
        return await getWorkspaceStatus(entry.workspace)
      } catch {
        return null
      }
    })
  )

  const msgs = []
  if (statuses.some((s) => s?.hasUncommitted)) {
    msgs.push("Some workspaces have uncommitted changes.")
  }

  if (countOtherSessions(null, sessionID) > 0) {
    msgs.push("Some workspaces are active in other sessions.")
  }

  return msgs
}

/**
 * Handle `/devcontainer rm all`
 */
export async function handleRemoveAll(sessionID, confirmed) {
  const entries = await collectRemoveAllEntries()

  if (entries.length === 0) {
    return "No devcontainers to clean up."
  }

  // Pre-removal warnings (skip when already confirmed)
  if (!confirmed) {
    const msgs = await removeAllWarnings(entries, sessionID)
    if (msgs.length > 0) {
      return msgs.join('\n') + '\n\nReply "yes" to confirm or "no" to cancel.'
    }
  }

  // Remove each devcontainer sequentially — remove() does read-modify-write
  // on the shared ports.json/jobs.json, so parallel runs could race
  let output = `Removing ${entries.length} devcontainer(s)...\n\n`
  let totalErrors = 0
  await entries.reduce(async (prev, entry) => {
    await prev
    const summary = await remove(entry.workspace, entry.repo, entry.branch)
    invalidateSessionCache(entry.workspace)
    output += formatRemoveSummary(summary) + '\n'
    totalErrors += summary.errors.length
  }, Promise.resolve())

  // Clear current session
  const session = loadSession(sessionID)
  if (session) {
    deleteSession(sessionID)
    output += `Active session cleared.\n`
  }

  output += `\nDone. ${totalErrors} error(s) during cleanup.`
  if (totalErrors > 0) {
    output += ` Some containers or images may need manual cleanup via \`docker\` commands.`
  }

  return output
}

/** Status text for a session whose container start job is pending/running/failed */
function describeStartingJob(session, job) {
  if (!job) return null
  if (job.status === JOB_STATUS.PENDING) {
    return `Current devcontainer: ${session.repoName}/${session.branch}\n` +
           `Workspace: ${session.workspace}\n` +
           `Status: Starting (pending)...\n\n` +
           `Container start is queued. Please wait.`
  }
  if (job.status === JOB_STATUS.RUNNING) {
    return `Current devcontainer: ${session.repoName}/${session.branch}\n` +
           `Workspace: ${session.workspace}\n` +
           `Status: Starting (in progress)...\n\n` +
           `Container is being built/started. This may take a few minutes.`
  }
  if (job.status === JOB_STATUS.FAILED) {
    return `Current devcontainer: ${session.repoName}/${session.branch}\n` +
           `Workspace: ${session.workspace}\n` +
           `Status: Failed to start\n\n` +
           `Error: ${job.error}\n\n` +
           `Use \`/devcontainer ${session.branch}\` to retry.`
  }
  return null
}

/** Status request (no target) for the `devcontainer` tool */
async function devcontainerStatus(sessionID) {
  const session = loadSession(sessionID)
  if (!session) {
    return "No devcontainer active for this session.\n\n" +
           "Use `/devcontainer <branch>` to target a devcontainer."
  }

  // Check for background job status
  if (session.starting) {
    const job = await getJob(session.workspace)
    const startingText = describeStartingJob(session, job)
    if (startingText) return startingText
    if (job?.status === JOB_STATUS.COMPLETED) {
      // Update session to remove starting flag
      saveSession(sessionID, {
        ...session,
        starting: false,
      })
      return `Current devcontainer: ${session.repoName}/${session.branch}\n` +
             `Workspace: ${session.workspace}\n` +
             `Port: ${job.port}\n` +
             `Status: Running\n\n` +
             `Container is ready! All commands will run inside this container.\n` +
             `Use \`/devcontainer off\` to disable.`
    }
  }

  const running = await isContainerRunning(session.workspace)
  return `Current devcontainer: ${session.repoName}/${session.branch}\n` +
         `Workspace: ${session.workspace}\n` +
         `Status: ${running ? "Running" : "Not running"}\n` +
         `\nUse \`/devcontainer off\` to disable.`
}

/** Disable request for the `devcontainer` tool */
function devcontainerOff(sessionID) {
  const session = loadSession(sessionID)
  deleteSession(sessionID)
  if (session) {
    return `Devcontainer mode disabled. Commands will now run on the host.`
  }
  return "No devcontainer was active for this session."
}

/** Start a not-yet-existing workspace in the background (non-blocking) */
async function startNewDevcontainer(sessionID, target, shouldCreate) {
  const baseline = loadSession(sessionID)
  try {
    const result = await upBackground(target, {
      cwd: process.cwd(),
    })

    if (!saveSessionIfCurrent(sessionID, baseline, {
      branch: result.branch,
      workspace: result.workspace,
      repoName: result.repo,
      starting: true,  // Mark as starting
    })) {
      return `Container start for ${result.repo}/${result.branch} was requested, ` +
             `but the session changed while it was starting - use \`/devcontainer\` to check status.`
    }

    return `Starting container for ${result.repo}/${result.branch}...\n` +
           `Workspace: ${result.workspace}\n\n` +
           `Container is being created in the background. This may take a few minutes.\n` +
           `Use \`/devcontainer\` to check status.\n\n` +
           `Session is now targeting this container. Commands will work once it's ready.`
  } catch (err) {
    // Quick validation failed (e.g., not in git repo, no devcontainer.json)
    if (!shouldCreate) {
      return `Cannot create devcontainer for '${target}'.\n\n` +
             `Error: ${err.message}\n\n` +
             `Make sure you're in a git repository with a devcontainer.json file.`
    }

    return `Failed to create workspace: ${err.message}`
  }
}

/** Attach the session to an already-tracked workspace (starting it if needed) */
async function attachDevcontainer(sessionID, resolved, target) {
  if (resolved.ambiguous) {
    const options = resolved.matches
      .map(m => `  - ${m.repoName}/${m.branch}`)
      .join("\n")
    return `Ambiguous branch '${target}' found in multiple repos:\n${options}\n\n` +
           `Use \`/devcontainer <repo>/${target}\` to specify.`
  }

  const { workspace, repoName, branch } = resolved
  const baseline = loadSession(sessionID)

  // Check if container is running
  const isRunning = await isContainerRunning(workspace)
  if (!isRunning) {
    // Container exists but not running - start it in background (non-blocking)
    try {
      await upBackground(workspace)

      if (!saveSessionIfCurrent(sessionID, baseline, { 
        branch, 
        workspace, 
        repoName,
        starting: true,  // Mark as starting
      })) {
        return `Container start for ${repoName}/${branch} was requested, ` +
               `but the session changed while it was starting - use \`/devcontainer\` to check status.`
      }

      return `Starting container for ${repoName}/${branch}...\n` +
             `Workspace: ${workspace}\n\n` +
             `Container is starting in the background. This may take a minute.\n` +
             `Use \`/devcontainer\` to check status.\n\n` +
             `Session is now targeting this container. Commands will work once it's ready.`
    } catch (err) {
      // Quick validation failed
      return `Failed to start container: ${err.message}`
    }
  }

  // Save session state (skip if the session changed during the status check)
  if (!saveSessionIfCurrent(sessionID, baseline, {
    branch,
    workspace,
    repoName,
  })) {
    return `Session changed while targeting ${repoName}/${branch} - ` +
           `use \`/devcontainer\` to check status.`
  }

  return `Session now targeting: ${repoName}/${branch}\n` +
         `Workspace: ${workspace}\n\n` +
         `All commands will run inside this container.\n` +
         `Use \`/devcontainer off\` to disable, or prefix with \`HOST:\` to run on host.`
}

/**
 * Shared executor for the `devcontainer` tool (target/off/rm/status).
 * Returns the user-facing string; entrypoints adapt it to their API shape.
 *
 * @param {{ target?: string, create?: string|boolean, confirmed?: boolean }} args
 * @param {{ sessionID: string, signal?: AbortSignal }} ctx
 */
export async function executeDevcontainerTool(args, ctx) {
  const { sessionID } = ctx
  const { target, create, confirmed } = args
  const shouldCreate = create === "true" || create === true

  // Disable request — session-only, works without the devcontainer CLI
  if (target === "off") {
    return devcontainerOff(sessionID)
  }

  // Remove request — needs docker (validated by core), not the devcontainer CLI
  if (target?.startsWith("rm ")) {
    const rmArg = target.slice(3).trim()

    if (!rmArg) {
      return "Usage: `/devcontainer rm <branch>` or `/devcontainer rm all`"
    }

    if (rmArg === "all") {
      return handleRemoveAll(sessionID, confirmed)
    }

    return handleRemoveSingle(rmArg, sessionID, confirmed)
  }

  // Verify devcontainer CLI is installed (status and start paths use it)
  const hasCli = await checkDevcontainerCli()
  if (!hasCli) {
    return "devcontainer CLI not found.\n\nInstall with: `npm install -g @devcontainers/cli`"
  }

  // Status request (no target)
  if (!target || target.trim() === "") {
    return devcontainerStatus(sessionID)
  }

  // Resolve workspace (check if clone already exists)
  const resolved = resolveWorkspace(target)

  if (!resolved) {
    // Workspace doesn't exist - start it in background (non-blocking)
    return startNewDevcontainer(sessionID, target, shouldCreate)
  }

  return attachDevcontainer(sessionID, resolved, target)
}

/** If the start job is still settling, return the user-facing message (null to proceed) */
async function settledStartingExecMessage(sessionID, session) {
  const job = await getJob(session.workspace)
  if (!job) return null
  if (job.status === JOB_STATUS.PENDING || job.status === JOB_STATUS.RUNNING) {
    return `Container is still starting for ${session.repoName}/${session.branch}.\n\n` +
           `Please wait and try again, or use \`/devcontainer\` to check status.`
  }
  if (job.status === JOB_STATUS.FAILED) {
    return `Container failed to start: ${job.error}\n\n` +
           `Use \`/devcontainer ${session.branch}\` to retry.`
  }
  if (job.status === JOB_STATUS.COMPLETED) {
    // Container is ready - update session to remove starting flag
    saveSession(sessionID, {
      ...session,
      starting: false,
    })
  }
  return null
}

/**
 * Shared executor for the `devcontainer_exec` tool.
 * Returns the user-facing string; entrypoints adapt it to their API shape.
 *
 * @param {{ command: string }} args
 * @param {{ sessionID: string, signal?: AbortSignal }} ctx
 * @returns {Promise<string>} User-facing command output or an error message
 */
export async function executeDevcontainerExecTool(args, ctx) {
  const { sessionID, signal } = ctx
  const { command } = args

  const session = loadSession(sessionID)
  if (!session?.workspace) {
    return "Error: No devcontainer context set for this session. Use `/devcontainer <branch>` first."
  }

  // Check if container is still starting
  if (session.starting) {
    const startingMessage = await settledStartingExecMessage(sessionID, session)
    if (startingMessage) return startingMessage
  }

  try {
    // Use the core exec function
    const result = await exec(session.workspace, command, { signal })

    if (result.exitCode !== 0) {
      return `Command failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`
    }

    return result.stdout
  } catch (err) {
    if (err.name === 'AbortError') {
      return `Command cancelled.`
    }
    return `Command failed: ${err.message}`
  }
}

/**
 * Shared shell-command interception used by the V1 `tool.execute.before` hook
 * and the V2 `ctx.tool.hook("execute.before")`. Matches the V1 `bash` tool
 * and the V2 `shell` tool.
 *
 * @param {{ tool: string, sessionID: string, command?: string, workdir?: string }} input
 * @returns {Promise<{ command?: string, workdir?: string }|null>} rewrites to
 *   apply, or null to leave the call untouched
 */
/** Starting-container interception: helpful echo, or flag reset on completion */
async function startingInterception(sessionID, session) {
  const job = await getJob(session.workspace)
  if (!job) return null
  if (job.status === JOB_STATUS.PENDING || job.status === JOB_STATUS.RUNNING) {
    // Rewrite to echo a helpful message instead of failing
    return { command: `echo "Container is still starting for ${session.repoName}/${session.branch}. Please wait and try again, or use /devcontainer to check status." && exit 1` }
  }
  if (job.status === JOB_STATUS.COMPLETED) {
    // Container is ready - update session
    saveSession(sessionID, { ...session, starting: false })
  }
  return null
}

/**
 * Intercept a shell/bash tool call for a session bound to a devcontainer.
 *
 * Rewrites the command to run via `devcontainer exec` inside the session's
 * container (or via git worktree for V1 worktree sessions). Commands whose
 * workdir lies outside the workspace, host-bound commands, and the HOST:
 * escape hatch pass through untouched. While the container is still
 * starting, returns a helpful message instead of a cryptic failure.
 *
 * @param {object} params
 * @param {string} params.tool - Tool name (`bash` or `shell`)
 * @param {string} params.sessionID - Session the command runs in
 * @param {string} params.command - Original command text
 * @param {string} [params.workdir] - Working directory for the command
 * @param {boolean} [params.allowWorktreeSessions] - V2 passes false: stale
 *   V1 worktree sessions must not reroute commands under V2
 * @returns {Promise<{command: string, workdir?: string}|null>} Rewritten
 *   command, or null to run the original untouched
 */
export async function interceptShellCommand({ tool, sessionID, command, workdir, allowWorktreeSessions = true }) {
  // Only intercept shell commands (V1: bash, V2: shell)
  if (tool !== "bash" && tool !== "shell") return null

  const session = loadSession(sessionID)
  if (!session?.workspace) return null

  // If workdir is specified and is not within the workspace, don't intercept
  // This handles the case where the user/agent is working in a different directory.
  // Boundary-aware: a sibling sharing the workspace prefix (/ws vs /ws-sibling)
  // is not inside the workspace, and the exact workspace path counts as inside.
  if (workdir && workdir !== session.workspace && !isInside(session.workspace, workdir)) {
    return null
  }

  const cmd = command?.trim()
  if (!cmd) return null

  const hostCheck = shouldRunOnHost(cmd)

  // Check for HOST: escape hatch
  if (hostCheck === "escape") {
    return { command: cmd.replace(/^HOST:\s*/i, "") }
  }

  // Check if command should run on host
  if (hostCheck) return null

  // Handle worktree sessions - just set workdir, no container wrapping.
  // Under V2 (allowWorktreeSessions: false) a persisted V1 worktree session
  // is stale state: V2 has native worktrees, so leave the command alone.
  if (session.type === "worktree") {
    return allowWorktreeSessions ? { workdir: session.workspace } : null
  }

  // Handle devcontainer sessions
  // Check if container is still starting - provide helpful error instead of cryptic failure
  if (session.starting) {
    const interception = await startingInterception(sessionID, session)
    if (interception) return interception
  }

  // Wrap with devcontainer exec (using safe command builder to prevent shell injection)
  return { command: buildDevcontainerExecCommand(session.workspace, cmd) }
}
