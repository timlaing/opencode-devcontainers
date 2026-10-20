// V2 plugin setup (OpenCode V2 plugin API). Registered from the combined
// entrypoint in index.js via Plugin.define({ id, setup }). Registers only the
// devcontainer functionality — OpenCode V2 supports worktrees natively.
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { runWithTimeout } from "./helpers.js"

import {
  executeDevcontainerTool,
  executeDevcontainerExecTool,
  cleanupStaleSessions,
  interceptShellCommand,
} from "./handlers.js"

import { cleanupJobs } from "./core/index.js"

// Timeout for init operations (2 seconds)
const INIT_TIMEOUT_MS = 2000

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Frontmatter-free body of the V1 /devcontainer command file */
function devcontainerCommandBody() {
  const raw = readFileSync(join(__dirname, "command", "devcontainer.md"), "utf-8")
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim()
}

export async function setup(ctx) {
  // Cleanup stale sessions (don't block on slow API)
  void runWithTimeout(
    () => cleanupStaleSessions(async () => {
      // V2's ctx.session.list() returns a bare array; older/newer shapes
      // returned { data }. An unexpected shape (e.g. an error payload)
      // must abort cleanup, never be mistaken for "no active sessions" —
      // that would delete every session file.
      const listed = await ctx.session.list()
      const sessions = Array.isArray(listed) ? listed : listed?.data
      if (!Array.isArray(sessions)) {
        throw new Error("unexpected session.list() shape; skipping stale-session cleanup")
      }
      return sessions.map((s) => s.id)
    }),
    INIT_TIMEOUT_MS
  )

  // Cleanup old jobs (don't block)
  void runWithTimeout(() => cleanupJobs(), INIT_TIMEOUT_MS)

  // /devcontainer command — V2 registers commands directly instead of
  // installing command files into the config directory (V1 behavior).
  const commandBody = devcontainerCommandBody()
  await ctx.command.transform((editor) => {
    editor.add({
      name: "devcontainer",
      description: "Target a devcontainer - /devcontainer <branch>, off. Or remove: /devcontainer rm <branch>, or rm all",
      execute: async ({ sessionID, prompt, delivery }) => {
        // Replacer function: prompt text is arbitrary input, and a string
        // replacement would expand `$&`/`$1`-style patterns in it
        const text = commandBody.replace("$ARGUMENTS", () => prompt.text ?? "")
        await ctx.session.prompt({ sessionID, text, delivery })
      },
    })
  })

  // Tools — same behavior as V1, adapted to the V2 tool API (JSON Schema
  // input, structured { content } results).
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "devcontainer_exec",
      description: "Execute a command in the current devcontainer context. IMPORTANT: Only use this tool when a devcontainer session is active (set via /devcontainer command). For normal shell commands, use the shell tool instead.",
      input: {
        type: "object",
        properties: {
          command: { type: "string", description: "Command to execute" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async (input, toolCtx) => ({
        content: await executeDevcontainerExecTool(input, {
          sessionID: toolCtx.sessionID,
          signal: toolCtx.signal,
        }),
      }),
    })

    editor.add({
      name: "devcontainer",
      description: "Set active devcontainer for this session. Use 'off' to disable. Set create=true to create a new workspace if it doesn't exist.",
      // Declares the `devcontainer` permission key so users can require
      // explicit approval (including for rm) via OpenCode's permission
      // configuration — see docs/configuration.md
      permission: "devcontainer",
      input: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Branch name (e.g., 'feature-x'), 'off' to disable, or empty for status",
          },
          create: {
            type: "string",
            description: "Set to 'true' to create the workspace if it doesn't exist (requires confirmation)",
          },
          confirmed: {
            type: "boolean",
            description: "Set to true to confirm the remove operation after reviewing warnings about uncommitted changes or other active sessions",
          },
        },
        additionalProperties: false,
      },
      execute: async (input, toolCtx) => ({
        content: await executeDevcontainerTool(input, {
          sessionID: toolCtx.sessionID,
          signal: toolCtx.signal,
        }),
      }),
    })
  })

  // Intercept shell commands to run in the session's devcontainer. V2's hook
  // receives one mutable event; only `input` is writable (no `output`).
  await ctx.tool.hook("execute.before", async (event) => {
    const input = event.input
    if (!input || typeof input !== "object") return

    const result = await interceptShellCommand({
      tool: event.tool,
      sessionID: event.sessionID,
      command: input.command,
      workdir: input.workdir,
      // V2 has native worktrees: a persisted V1 worktree session is stale
      // state and must not reroute commands into the legacy workspace
      allowWorktreeSessions: false,
    })
    if (!result) return
    if (result.command !== undefined) input.command = result.command
    if (result.workdir !== undefined) input.workdir = result.workdir
  })
}
