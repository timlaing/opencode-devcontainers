#!/usr/bin/env node
// End-to-end check of the V2 plugin against a real OpenCode runtime.
//
// The unit tests drive the plugin through a fake plugin context, which can
// prove plugin logic but not the wiring inside OpenCode itself. This script
// loads the plugin through OpenCode's actual V2 loader in a sandboxed
// environment and exercises, over the real HTTP API:
//
//   1. registration    - plugin list (state active), /devcontainer command,
//                        and `devcontainer` present in the toolset the real
//                        agent loop sends to the model
//   2. init cleanup    - stale session files removed at plugin setup,
//                        against the real ctx.session.list, while active
//                        sessions are preserved across a server restart
//   3. command         - POST /session/{id}/command runs the command's
//                        execute callback: $ARGUMENTS substitution and
//                        ctx.session.prompt forwarding through the real
//                        runtime
//   4. tool dispatch   - the real agent loop calls the `devcontainer` tool
//                        (session state saved, background container start
//                        runs: clone + shimmed devcontainer up) and the
//                        `devcontainer_exec` tool (core exec)
//   5. shell hook      - the real `shell` tool execution passes through
//                        tool.execute.before, which rewrites `npm test`
//                        into `devcontainer exec ... npm test`; asserted on
//                        the tool RESULT (only the wrapped command can
//                        reach the shimmed CLI)
//   6. multi-session   - a second session without devcontainer state runs
//                        the same command on the host: no reroute, no
//                        session state leaked
//
// Only external dependencies are faked, so the check is deterministic,
// offline, and free:
//   - the devcontainer/docker CLIs (PATH shims; the wrapped command is
//     only observable via the shim's E2E-EXEC marker)
//   - the LLM (a scripted OpenAI-compatible server driving the agent loop
//     through canned tool calls)
//
// Usage:  npm run e2e:v2     (requires the OpenCode V2 CLI on PATH)
// Env:    OCDC_E2E_KEEP=1    keep the sandbox for inspection

import { execFile, execFileSync, spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const KEEP = process.env.OCDC_E2E_KEEP === "1"

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const results = []
const sections = []

function section(name) {
  sections.push(name)
  console.log(`\n== ${name}`)
}

function record(ok, label, detail) {
  results.push({ ok, label, detail, section: sections[sections.length - 1] })
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? `\n         ${detail}` : ""}`)
}

function check(cond, label, detail) {
  record(Boolean(cond), label, detail)
  return Boolean(cond)
}

const flat = (v) => (typeof v === "string" ? v : JSON.stringify(v ?? ""))
const countOf = (haystack, needle) => haystack.split(needle).length - 1

/**
 * Collects tool parts (`{ name, state: { input, content } }`) from any
 * message payload shape, so assertions can target a tool's RESULT instead
 * of accidentally matching its INPUT.
 *
 * @param {*} node - payload subtree
 * @param {Array<object>} [acc] - accumulator
 * @returns {Array<object>} tool parts
 */
function collectToolParts(node, acc = []) {
  if (Array.isArray(node)) {
    for (const child of node) collectToolParts(child, acc)
    return acc
  }
  if (node && typeof node === "object") {
    if (node.name && node.state && typeof node.state === "object") {
      acc.push(node)
      return acc
    }
    for (const value of Object.values(node)) collectToolParts(value, acc)
  }
  return acc
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

// realpath: on macOS /var/folders is a symlink to /private/var/folders. The
// server realpath()s its working directory, so every location the script
// passes must be realpath'd too or sessions land outside the booted
// location.
const TMP_BASE = realpathSync(join(tmpdir(), "opencode"))
mkdirSync(TMP_BASE, { recursive: true })
const sandbox = realpathSync(mkdtempSync(join(TMP_BASE, "ocdc-e2e-")))
const home = join(sandbox, "home")
const project = join(sandbox, "project")
const fakeBin = join(sandbox, "bin")
const configDir = join(sandbox, "devcontainer-config")
const cacheDir = join(sandbox, "cache")
const clonesDir = join(sandbox, "clones")
const sessionsDir = join(sandbox, "sessions")
const worktreesDir = join(sandbox, "worktrees")

const jobsFile = join(cacheDir, "jobs.json")
const sessionFile = (id) => join(sessionsDir, `${id}.json`)

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

// Environment for every OpenCode process: fully sandboxed HOME + state dirs,
// shimmed PATH for the container CLIs, and no inherited OPENCODE_* variables
// (this script itself runs inside an OpenCode session). A fixed
// OPENCODE_PASSWORD is shared by the sandboxed serve process and the API.
function serviceEnv() {
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    E2E_API_KEY: "e2e-dummy-key",
    OCDC_CONFIG_DIR: configDir,
    OCDC_CACHE_DIR: cacheDir,
    OCDC_CLONES_DIR: clonesDir,
    OCDC_SESSIONS_DIR: sessionsDir,
    OCDC_WORKTREES_DIR: worktreesDir,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENCODE") && key !== "OPENCODE_PASSWORD") delete env[key]
  }
  env.OPENCODE_PASSWORD = "e2e-serve-password"
  return env
}

function writeShim(name, body) {
  const path = join(fakeBin, name)
  writeFileSync(path, body, { mode: 0o755 })
  chmodSync(path, 0o755)
}

function git(args) {
  return execFileSync("git", args, { cwd: project, encoding: "utf8" })
}

function setupSandbox() {
  for (const dir of [
    home,
    join(home, ".config", "opencode"),
    project,
    fakeBin,
    configDir,
    cacheDir,
    clonesDir,
    sessionsDir,
    worktreesDir,
  ]) {
    mkdirSync(dir, { recursive: true })
  }

  // Shimmed devcontainer CLI: `up` succeeds (stdout is not parsed),
  // `exec` echoes a marker that is only reachable through wrapping.
  writeShim(
    "devcontainer",
    `#!/bin/sh
case "$1" in
  exec)
    echo "E2E-EXEC: $*"
    exit 0
    ;;
  up)
    echo '{"success":true,"containerId":"e2e-container","remoteUser":"root"}'
    exit 0
    ;;
  *)
    echo "e2e-devcontainer-shim"
    exit 0
    ;;
esac
`,
  )

  // Shimmed docker: nothing running, all mutations succeed.
  writeShim("docker", `#!/bin/sh\nexit 0\n`)

  // Throwaway project repo with a devcontainer config on branch main.
  mkdirSync(join(project, ".devcontainer"), { recursive: true })
  writeFileSync(
    join(project, ".devcontainer", "devcontainer.json"),
    JSON.stringify({ name: "e2e" }, null, 2),
  )
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify(
      { name: "e2e-project", version: "1.0.0", scripts: { test: "echo RAW-NPM-TEST" } },
      null,
      2,
    ),
  )
  writeFileSync(join(project, "README.md"), "# e2e project\n")

  try {
    git(["init", "-b", "main"])
  } catch {
    git(["init"])
    git(["symbolic-ref", "HEAD", "refs/heads/main"])
  }
  git(["config", "commit.gpgsign", "false"])
  git(["config", "user.email", "e2e@example.com"])
  git(["config", "user.name", "E2E"])
  git(["add", "-A"])
  git(["commit", "-m", "e2e scaffold"])

  // Stale session file planted before first start: init cleanup must remove
  // it (there are no sessions yet, so nothing is active).
  writeFileSync(
    join(sessionsDir, "ses_e2e_stale1.json"),
    JSON.stringify({ workspace: "/nonexistent/e2e" }),
  )
}

function writePluginConfig(llmUrl) {
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: "e2e/scripted",
    // Local plugin directory (verified shape: the loader resolves
    // <dir>/index.js; the package root entry does NOT resolve).
    plugins: [{ package: join(REPO_ROOT, "plugin"), options: {} }],
    providers: {
      e2e: {
        name: "E2E Scripted",
        env: ["E2E_API_KEY"],
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `${llmUrl}/v1` },
        models: { scripted: { name: "E2E Scripted Model" } },
      },
    },
  }
  writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify(config, null, 2))
}

// ---------------------------------------------------------------------------
// Scripted OpenAI-compatible LLM
// ---------------------------------------------------------------------------

const llmRequests = []

function contentToString(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? part?.content ?? ""))
      .join("\n")
  }
  return ""
}

// Decides each model reply from the conversation so far. The command prompt
// carries the substituted $ARGUMENTS text, which is how the target reaches
// the tool call - the same path a real model would take.
function scriptReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const last = messages[messages.length - 1]
  const text = contentToString(last?.content)
  const toolCapable = Array.isArray(body?.tools) && body.tools.length > 0

  if (!toolCapable) return { kind: "text", text: "E2E session" }

  if (last?.role === "tool") {
    if (text.includes("Starting container for")) return { kind: "text", text: "STEP1-DONE" }
    return { kind: "text", text: "E2E-COMPLETE" }
  }

  if (last?.role === "user") {
    const target = text.match(/Call the `devcontainer` tool with `target` set to: *([^\n]+)/)
    if (target) return { kind: "tool", name: "devcontainer", args: { target: target[1].trim() } }
    if (text.includes("run pwd via devcontainer_exec")) {
      return { kind: "tool", name: "devcontainer_exec", args: { command: "pwd E2E-EXEC-2" } }
    }
    if (text.includes("run npm test")) return { kind: "tool", name: "shell", args: { command: "npm test" } }
  }

  return { kind: "text", text: "E2E session" }
}

let callCounter = 0
const chunkBase = (model) => ({ id: "e2e", object: "chat.completion.chunk", created: 0, model })

function sseChunks(model, reply) {
  if (reply.kind === "text") {
    return [
      { ...chunkBase(model), choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }] },
      { ...chunkBase(model), choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]
  }
  const id = `call_e2e_${++callCounter}`
  return [
    {
      ...chunkBase(model),
      choices: [{
        index: 0,
        delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id, type: "function", function: { name: reply.name, arguments: "" } }] },
        finish_reason: null,
      }],
    },
    {
      ...chunkBase(model),
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.args) } }] }, finish_reason: null }],
    },
    { ...chunkBase(model), choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]
}

function jsonCompletion(model, reply) {
  const message =
    reply.kind === "text"
      ? { role: "assistant", content: reply.text }
      : {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call_e2e_${++callCounter}`,
              type: "function",
              function: { name: reply.name, arguments: JSON.stringify(reply.args) },
            },
          ],
        }
  return {
    id: "e2e",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: reply.kind === "text" ? "stop" : "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }
}

let llmServer = null
let llmPort = 0

async function startLlm() {
  llmServer = createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: "scripted", object: "model" }] }))
        return
      }
      if (!req.url?.includes("/chat/completions")) {
        res.writeHead(404).end()
        return
      }
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
      } catch {
        /* keep {} */
      }
      const reply = scriptReply(body)
      const last = body?.messages?.[body.messages.length - 1]
      llmRequests.push({
        tools: Array.isArray(body?.tools) ? body.tools.map((t) => t?.function?.name ?? t?.name) : [],
        lastRole: last?.role,
        lastText: contentToString(last?.content).slice(0, 160),
        reply: reply.kind === "text" ? `text:${reply.text}` : `tool:${reply.name}:${JSON.stringify(reply.args)}`,
      })
      if (body.stream === false) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify(jsonCompletion(body.model ?? "scripted", reply)))
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      for (const chunk of sseChunks(body.model ?? "scripted", reply)) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      }
      res.write("data: [DONE]\n\n")
      res.end()
    })
  })
  await new Promise((res, rej) => {
    llmServer.once("error", rej)
    llmServer.listen(0, "127.0.0.1", () => {
      llmPort = llmServer.address().port
      res()
    })
  })
  return `http://127.0.0.1:${llmPort}`
}

// ---------------------------------------------------------------------------
// OpenCode server + API helpers
// ---------------------------------------------------------------------------

const opencodeBin = execFileSync("which", ["opencode"], { encoding: "utf8" }).trim()
const serveLogs = []
let serveProc = null
let serveUrl = null

function pushServeLog(stream, data) {
  const lines = String(data).split("\n").filter(Boolean)
  for (const line of lines) serveLogs.push(`[${stream}] ${line}`)
  if (serveLogs.length > 400) serveLogs.splice(0, serveLogs.length - 400)
}

function serveLogTail(lines = 30) {
  return serveLogs
    .slice(-lines)
    .join("\n")
    .replace(/server password \S+/g, "server password <redacted>")
}

async function freePort() {
  return new Promise((res, rej) => {
    const probe = createServer()
    probe.once("error", rej)
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => res(port))
    })
  })
}

async function startServe() {
  const port = await freePort()
  serveUrl = `http://127.0.0.1:${port}`
  serveProc = spawn(opencodeBin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: serviceEnv(),
    cwd: project,
    stdio: ["ignore", "pipe", "pipe"],
  })
  serveProc.stdout.on("data", (d) => pushServeLog("out", d))
  serveProc.stderr.on("data", (d) => pushServeLog("err", d))
  serveProc.on("exit", (code, signal) => serveLogs.push(`[exit] code=${code} signal=${signal}`))

  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (serveProc.exitCode !== null) break
    const probe = await api("GET", "/api/info")
    if (probe.ok) return
    await sleep(500)
  }
  throw new Error(`opencode serve did not become ready at ${serveUrl}\n${serveLogTail()}`)
}

async function stopServe() {
  if (!serveProc) return
  const proc = serveProc
  serveProc = null
  proc.kill("SIGTERM")
  await Promise.race([
    new Promise((res) => proc.once("exit", res)),
    sleep(5000).then(() => proc.kill("SIGKILL")),
  ])
}

function jsonLenient(out) {
  const s = String(out ?? "").trim()
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    /* fall through */
  }
  const first = s.search(/[[{]/)
  if (first >= 0) {
    const lastClose = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"))
    if (lastClose > first) {
      try {
        return JSON.parse(s.slice(first, lastClose + 1))
      } catch {
        /* fall through */
      }
    }
  }
  return s
}

async function api(method, path, data, params = {}) {
  const args = ["api", "--server", serveUrl, method, path]
  for (const [key, value] of Object.entries(params)) args.push("--param", `${key}=${value}`)
  if (data !== undefined) args.push("--data", JSON.stringify(data))
  try {
    const { stdout } = await execFileP(opencodeBin, args, {
      env: serviceEnv(),
      cwd: project,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60000,
    })
    return { ok: true, body: jsonLenient(stdout), raw: String(stdout) }
  } catch (err) {
    return {
      ok: false,
      body: jsonLenient(err.stdout || ""),
      raw: String(err.stdout || ""),
      error: String(err.stderr || err.message || "").trim(),
    }
  }
}

async function sessionMessages(id) {
  const r = await api("GET", `/api/session/${id}/message`)
  return r.ok ? r.body : null
}

async function sessionFlat(id) {
  return flat(await sessionMessages(id))
}

// Polls until fn() returns a truthy evidence value (string used as detail).
async function eventually(label, fn, timeout = 60000) {
  const deadline = Date.now() + timeout
  let evidence = null
  while (Date.now() < deadline) {
    try {
      evidence = await fn()
    } catch {
      evidence = null
    }
    if (evidence) {
      record(true, label, typeof evidence === "string" ? evidence : "")
      return true
    }
    await sleep(400)
  }
  record(false, label, llmDiag())
  return false
}

function llmDiag() {
  const last = llmRequests[llmRequests.length - 1]
  if (!last) return "no LLM requests observed"
  return `last LLM request: role=${last.lastRole} tools=[${last.tools.join(",")}] reply=${last.reply} text="${last.lastText}"`
}

async function ourPlugin() {
  const r = await api("GET", "/api/plugin", undefined, { "location[directory]": project })
  const list = r.body?.data ?? (Array.isArray(r.body) ? r.body : [])
  if (!Array.isArray(list)) return null
  return list.find((p) => p?.id === "opencode-devcontainers") ?? null
}

async function ourCommand() {
  const r = await api("GET", "/api/command", undefined, { "location[directory]": project })
  const list = r.body?.data ?? (Array.isArray(r.body) ? r.body : [])
  if (!Array.isArray(list)) return null
  return list.find((c) => c?.name === "devcontainer") ?? null
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkRegistration() {
  section("1. Real-runtime plugin registration")

  await eventually(
    "plugin loaded through the real V2 loader with state active",
    async () => {
      const mine = await ourPlugin()
      return mine?.state?.status === "active" && `id=${mine.id} state=${flat(mine.state)}`
    },
    45000,
  )

  await eventually(
    "/devcontainer command registered with the real command registry",
    async () => {
      const cmd = await ourCommand()
      return Boolean(cmd) && "command present"
    },
    30000,
  )
}

async function checkInitCleanup() {
  section("2. Init stale-session cleanup against the real session list")

  const stale1 = join(sessionsDir, "ses_e2e_stale1.json")
  await eventually(
    "stale session file removed at plugin init",
    () => !existsSync(stale1) && "removed",
    20000,
  )
}

async function checkCommandAndTool() {
  section("3. Real command execution and devcontainer tool dispatch (session A)")

  const created = await api("POST", "/api/session", {
    title: "E2E A",
    location: { directory: project },
  })
  const idA = created.body?.data?.id ?? created.body?.id
  if (!check(created.ok && typeof idA === "string" && idA.length > 0, "session A created", `id=${idA || created.error}`)) {
    return null
  }

  const execd = await api("POST", `/api/session/${idA}/command`, {
    name: "devcontainer",
    text: "main",
  })
  if (!check(execd.ok, "POST /session/{id}/command accepted", execd.ok ? "2xx" : execd.error)) {
    // Everything below depends on the command having run.
    return idA
  }

  await eventually(
    "command execute callback forwarded $ARGUMENTS-substituted prompt",
    async () => {
      const flatMsgs = await sessionFlat(idA)
      return flatMsgs.includes("set to: main") && "prompt text carries target: main"
    },
    45000,
  )

  await eventually(
    "devcontainer tool present in the real agent loop's toolset",
    () =>
      llmRequests.some((r) => r.tools.includes("devcontainer")) &&
      `tools=[${llmRequests.find((r) => r.tools.includes("devcontainer")).tools.join(",")}]`,
    30000,
  )

  await eventually(
    "real agent loop dispatched the devcontainer tool (result-based)",
    async () => {
      const payload = await sessionMessages(idA)
      const parts = collectToolParts(payload).filter((p) => p.name === "devcontainer")
      const outputs = parts.map((p) => flat(p.state?.content ?? p.state)).join(" ")
      return outputs.includes("Starting container for project/main") && "tool result: Starting container for project/main"
    },
    45000,
  )

  await eventually(
    "agent loop completed after scripted reply (STEP1-DONE)",
    async () => {
      const flatMsgs = await sessionFlat(idA)
      return flatMsgs.includes("STEP1-DONE") && "assistant text present"
    },
    45000,
  )

  await eventually(
    "session state written by real tool execution",
    () => {
      const state = readJsonFile(sessionFile(idA))
      if (!state?.workspace || !state.workspace.startsWith(clonesDir)) return false
      return `workspace=${state.workspace} starting=${state.starting}`
    },
    15000,
  )

  await eventually(
    "background container start completed through shims",
    () => {
      const jobs = readJsonFile(jobsFile)
      return jobs && flat(jobs).includes('"completed"') && "jobs.json has completed status"
    },
    60000,
  )

  return idA
}

async function checkShellHook(idA) {
  section("4. Real shell-tool interception via tool.execute.before (session A)")

  const completesBefore = countOf(await sessionFlat(idA), "E2E-COMPLETE")

  const prompted = await api("POST", `/api/session/${idA}/prompt`, { text: "run npm test" })
  check(prompted.ok, "prompt accepted for shell scenario", prompted.ok ? "2xx" : prompted.error)

  await eventually(
    "shell tool RESULT shows the devcontainer exec rewrite (E2E-EXEC marker)",
    async () => {
      const payload = await sessionMessages(idA)
      const shellOutputs = collectToolParts(payload)
        .filter((p) => p.name === "shell")
        .map((p) => flat(p.state?.content ?? p.state))
        .join(" ")
      return shellOutputs.includes("E2E-EXEC") && "wrapped command output observed"
    },
    60000,
  )

  await eventually(
    "agent loop completed for shell scenario",
    async () => {
      const flatMsgs = await sessionFlat(idA)
      return countOf(flatMsgs, "E2E-COMPLETE") > completesBefore && "new E2E-COMPLETE assistant text"
    },
    45000,
  )

  const state = readJsonFile(sessionFile(idA))
  check(
    state && state.starting === false,
    "starting flag cleared by the hook after job completion",
    state ? `starting=${state.starting}` : "session file missing",
  )

  section("5. devcontainer_exec tool dispatch (session A)")

  const completesBefore2 = countOf(await sessionFlat(idA), "E2E-COMPLETE")

  const execPrompt = await api("POST", `/api/session/${idA}/prompt`, {
    text: "run pwd via devcontainer_exec",
  })
  check(execPrompt.ok, "prompt accepted for devcontainer_exec scenario", execPrompt.ok ? "2xx" : execPrompt.error)

  await eventually(
    "devcontainer_exec RESULT shows core exec output (E2E-EXEC-2 marker)",
    async () => {
      const payload = await sessionMessages(idA)
      const parts = collectToolParts(payload).filter((p) => p.name === "devcontainer_exec")
      const good = parts.find(
        (p) =>
          (p.state?.status ?? "completed") === "completed" &&
          flat(p.state?.content ?? p.state).includes("E2E-EXEC-2"),
      )
      return good && `output=${flat(good.state?.content).slice(0, 120)}`
    },
    60000,
  )

  await eventually(
    "agent loop completed for devcontainer_exec scenario",
    async () => {
      const flatMsgs = await sessionFlat(idA)
      return countOf(flatMsgs, "E2E-COMPLETE") > completesBefore2 && "new E2E-COMPLETE assistant text"
    },
    45000,
  )
}

async function checkMultiSessionRouting() {
  section("6. Multi-session routing isolation (session B)")

  const created = await api("POST", "/api/session", {
    title: "E2E B",
    location: { directory: project },
  })
  const idB = created.body?.data?.id ?? created.body?.id
  if (!check(created.ok && typeof idB === "string" && idB.length > 0, "session B created", `id=${idB || created.error}`)) {
    return null
  }

  const prompted = await api("POST", `/api/session/${idB}/prompt`, { text: "run npm test" })
  check(prompted.ok, "prompt accepted", prompted.ok ? "2xx" : prompted.error)

  await eventually(
    "unbound session ran the command on the host (RAW-NPM-TEST)",
    async () => {
      const flatMsgs = await sessionFlat(idB)
      return flatMsgs.includes("RAW-NPM-TEST") && "host output observed"
    },
    60000,
  )

  await eventually(
    "agent loop completed for session B",
    async () => {
      const flatMsgs = await sessionFlat(idB)
      return flatMsgs.includes("E2E-COMPLETE") && "assistant text present"
    },
    45000,
  )

  const payloadB = await sessionMessages(idB)
  const shellOutputsB = collectToolParts(payloadB)
    .filter((p) => p.name === "shell")
    .map((p) => flat(p.state?.content ?? p.state))
    .join(" ")
  check(
    !shellOutputsB.includes("E2E-EXEC"),
    "session B commands were not rerouted into a container",
    "shell result has no E2E-EXEC marker",
  )

  check(
    !existsSync(sessionFile(idB)),
    "no devcontainer session state leaked into session B",
    `no file for ${idB}`,
  )

  return idB
}

async function checkRestartCleanup(idA) {
  section("7. Init cleanup across restart preserves active sessions")

  const stale2 = join(sessionsDir, "ses_e2e_stale2.json")
  writeFileSync(stale2, JSON.stringify({ workspace: "/nonexistent/e2e2" }))

  await stopServe()
  await startServe()

  await eventually(
    "plugin active again after server restart",
    async () => {
      const mine = await ourPlugin()
      return mine?.state?.status === "active" && `state=${flat(mine.state)}`
    },
    45000,
  )

  await eventually(
    "stale session removed on restart while active session A is preserved",
    async () => {
      if (existsSync(stale2)) return false
      if (!existsSync(sessionFile(idA))) return false
      return "stale2 removed, session A state kept"
    },
    25000,
  )

  check(
    !existsSync(join(sessionsDir, "ses_e2e_stale1.json")),
    "session file from first init stays removed",
    "stale1 still gone",
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function dumpDiagnostics() {
  console.log("\n--------- diagnostics ---------")
  console.log(`sandbox: ${sandbox}`)
  console.log(`serve url: ${serveUrl}`)
  console.log(`session files: ${readdirSync(sessionsDir).join(", ") || "(none)"}`)
  const jobs = readJsonFile(jobsFile)
  console.log(`jobs: ${flat(jobs).slice(0, 500)}`)
  console.log("last 8 LLM requests:")
  for (const r of llmRequests.slice(-8)) {
    console.log(`  role=${r.lastRole} tools=[${r.tools.join(",")}] reply=${r.reply}`)
    console.log(`    text="${r.lastText}"`)
  }
  console.log("message dumps:")
  for (const sid of readdirSync(sessionsDir).filter((f) => f.startsWith("ses_") && !f.includes("stale"))) {
    const id = sid.replace(/\.json$/, "")
    const payload = await sessionMessages(id)
    console.log(`  ${id}: ${flat(payload).slice(0, 600)}`)
  }
  console.log("serve log tail:")
  console.log(serveLogTail(25) || "(empty)")
  console.log("-------------------------------")
}

async function main() {
  console.log("opencode-devcontainers V2 end-to-end check")
  console.log(`sandbox: ${sandbox}`)

  section("0. Preflight")

  const version = execFileSync(opencodeBin, ["--version"], { encoding: "utf8" }).trim()
  if (!check(/v2\./.test(version), "OpenCode V2 CLI available", version)) {
    throw new Error("This check requires the OpenCode V2 CLI (opencode v2.x) on PATH.")
  }

  if (
    !check(
      existsSync(join(REPO_ROOT, "node_modules", "@opencode", "plugin")),
      "plugin dependencies installed (npm install)",
      "@opencode/plugin resolvable from the repo",
    )
  ) {
    throw new Error("Run `npm install` in the repository first.")
  }

  section("0.1 Sandbox setup")
  setupSandbox()
  const llmUrl = await startLlm()
  writePluginConfig(llmUrl)
  record(true, "sandbox ready", `llm=${llmUrl}`)

  await startServe()
  record(true, "opencode serve started", serveUrl)

  await checkRegistration()
  await checkInitCleanup()
  const idA = await checkCommandAndTool()
  if (idA) {
    await checkShellHook(idA)
  }
  await checkMultiSessionRouting()
  if (idA) {
    await checkRestartCleanup(idA)
  }
}

let exitCode = 0
try {
  await main()
} catch (err) {
  exitCode = 1
  console.error(`\nE2E check aborted: ${err.message}`)
  results.push({ ok: false, label: `aborted: ${err.message}`, detail: "", section: "abort" })
} finally {
  await stopServe()
  if (llmServer) llmServer.close()
}

const failed = results.filter((r) => !r.ok)
console.log(`\nE2E summary: ${results.length - failed.length} passed, ${failed.length} failed`)
for (const f of failed) console.log(`  FAILED [${f.section}] ${f.label}`)

if (failed.length > 0) await dumpDiagnostics()

if (failed.length > 0 || KEEP) {
  console.log(`sandbox kept at: ${sandbox}`)
} else {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

process.exit(failed.length > 0 || exitCode ? 1 : 0)
