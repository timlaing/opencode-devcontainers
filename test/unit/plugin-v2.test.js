/**
 * Tests for the V2 plugin implementation (setup() on the combined entrypoint
 * in plugin/index.js, implemented in plugin/v2.js).
 *
 * Covers:
 * - The combined entrypoint shape (Plugin.define id/setup + server())
 * - setup() registrations: /devcontainer command, devcontainer and
 *   devcontainer_exec tools (JSON Schema input, { content } results), and the
 *   execute.before hook on the V2 `shell` tool
 * - The tool executors and the shell interception hook through the V2 API
 *
 * Uses a fake plugin context (ctx) capturing transform/hook registrations;
 * external commands are replaced with fake executables on PATH via the shared
 * harness so tests are hermetic and deterministic.
 *
 * Run with: node --test test/unit/plugin-v2.test.js
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { join } from 'path'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'

// Module under test
import plugin, { devcontainers } from '../../plugin/index.js'
import { setup } from '../../plugin/v2.js'
import { getOverridePath } from '../../plugin/core/config.js'
import { JOB_STATUS } from '../../plugin/core/jobs.js'

// Shared hermetic harness (testDir/fakeBin are live bindings)
import {
  testDir,
  sid, saveSession, writeSessionFile, writeJobs, waitFor, makeGitRepo,
  activeSessions, waitForJobSettled,
  setupEnv, teardownEnv,
} from './harness.js'

// The plugin resolves commands via `which` and runs them with `sh -c`, and
// the fake CLIs here are POSIX shell scripts — so this suite is POSIX-only.
const describeIfPosix = process.platform === 'win32' ? describe.skip : describe

beforeEach(setupEnv)
afterEach(teardownEnv)

// ============ Fake plugin context ============

/** Fake V2 plugin ctx capturing transform/hook registrations */
function makeFakeCtx({ sessions = [], prompts = [], rawSessionList = false, listOverride = null } = {}) {
  const tools = []
  const hooks = []
  const commands = []
  const ctx = {
    location: {
      directory: testDir,
      project: { id: 'test-project', directory: testDir, canonical: testDir },
    },
    options: {},
    session: {
      // V2's ctx.session.list() returns a bare array; older/newer shapes
      // returned { data }. rawSessionList exercises the V2 shape; a
      // listOverride fakes malformed shapes (e.g. error payloads).
      list: listOverride
        ?? (rawSessionList ? async () => sessions : async () => ({ data: sessions })),
      prompt: async (input) => { prompts.push(input); return {} },
    },
    command: {
      transform: async (cb) => {
        cb({ add: (c) => commands.push(c) })
        return { dispose: async () => {} }
      },
    },
    tool: {
      transform: async (cb) => {
        cb({ add: (t) => tools.push(t) })
        return { dispose: async () => {} }
      },
      hook: async (name, cb) => {
        hooks.push({ name, cb })
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx, tools, hooks, commands, prompts }
}

/** Run setup() against a fake ctx; sessions default to this test's registry */
async function setupV2({ sessions, prompts } = {}) {
  const fake = makeFakeCtx({ sessions: sessions ?? activeSessions(), prompts })
  await setup(fake.ctx)
  return fake
}

function toolByName(tools, name) {
  return tools.find(t => t.name === name)
}

function hookByName(hooks, name) {
  return hooks.find(h => h.name === name)
}

// ============ Entry shape ============

describeIfPosix('combined entrypoint', () => {
  test('default export carries the V2 definition and the V1 server()', () => {
    assert.strictEqual(plugin.id, 'opencode-devcontainers')
    assert.strictEqual(typeof plugin.setup, 'function')
    assert.strictEqual(typeof plugin.server, 'function')
  })

  test('named devcontainers export is the V1 factory', () => {
    assert.strictEqual(devcontainers, plugin.server)
  })
})

// ============ setup() registrations ============

describeIfPosix('setup registrations', () => {
  test('registers the /devcontainer command', async () => {
    const { commands } = await setupV2()
    assert.strictEqual(commands.length, 1)
    assert.strictEqual(commands[0].name, 'devcontainer')
    assert.strictEqual(typeof commands[0].execute, 'function')
  })

  test('registers both tools with JSON Schema input', async () => {
    const { tools } = await setupV2()
    assert.strictEqual(tools.length, 2)

    const exec = toolByName(tools, 'devcontainer_exec')
    assert.ok(exec, 'devcontainer_exec registered')
    assert.deepStrictEqual(exec.input.required, ['command'])
    assert.strictEqual(exec.input.type, 'object')

    const dc = toolByName(tools, 'devcontainer')
    assert.ok(dc, 'devcontainer registered')
    assert.strictEqual(dc.input.type, 'object')
    assert.ok(dc.input.properties.target, 'target property defined')
    assert.ok(dc.input.properties.create, 'create property defined')
    assert.ok(dc.input.properties.confirmed, 'confirmed property defined')
  })

  test('registers the execute.before hook', async () => {
    const { hooks } = await setupV2()
    const hook = hookByName(hooks, 'execute.before')
    assert.ok(hook, 'execute.before hook registered')
  })

  test('reports saved sessions to ctx.session.list so init keeps their files', async () => {
    const sessionID = sid('init-keep')
    const stale = sid('init-stale')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/keep' })
    writeSessionFile(stale, { workspace: '/ws/stale' })

    // Explicit list keeps only the active session, so the stale file is
    // removed by init cleanup rather than surviving on the registry
    await setupV2({ sessions: [{ id: sessionID }] })

    const kept = await waitFor(() => existsSync(join(testDir, 'sessions', `${sessionID}.json`)))
    assert.ok(kept, 'active session file kept')
    const removed = await waitFor(() => !existsSync(join(testDir, 'sessions', `${stale}.json`)))
    assert.ok(removed, 'stale session file removed')
  })

  test('skips cleanup on an unexpected session.list() shape', async () => {
    const sessionID = sid('init-weird-keep')
    const stale = sid('init-weird-stale')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/keep' })
    writeSessionFile(stale, { workspace: '/ws/stale' })

    // A malformed shape (e.g. an error payload) must abort cleanup, never
    // be mistaken for "no active sessions" and delete everything
    const fake = makeFakeCtx({ listOverride: async () => ({}) })
    await setup(fake.ctx)

    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.ok(existsSync(join(testDir, 'sessions', `${sessionID}.json`)), 'active session kept')
    assert.ok(existsSync(join(testDir, 'sessions', `${stale}.json`)), 'stale file kept — cleanup skipped')
  })

  test('handles ctx.session.list returning a bare array (V2 shape)', async () => {
    const sessionID = sid('init-array-keep')
    const stale = sid('init-array-stale')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/keep' })
    writeSessionFile(stale, { workspace: '/ws/stale' })

    // The V2 list() shape is a bare SessionInfo[] — a shape mismatch must
    // never be mistaken for "no active sessions" and delete everything
    const fake = makeFakeCtx({ sessions: [{ id: sessionID }], rawSessionList: true })
    await setup(fake.ctx)

    const kept = await waitFor(() => existsSync(join(testDir, 'sessions', `${sessionID}.json`)))
    assert.ok(kept, 'active session survives the array-shaped list')
    const removed = await waitFor(() => !existsSync(join(testDir, 'sessions', `${stale}.json`)))
    assert.ok(removed, 'stale session file removed')
  })

  test('devcontainer tool declares its permission key', async () => {
    const { tools } = await setupV2()
    const dc = toolByName(tools, 'devcontainer')
    assert.ok(dc, 'devcontainer registered')
    assert.strictEqual(dc.permission, 'devcontainer')
  })
})

// ============ /devcontainer command ============

describeIfPosix('/devcontainer command', () => {
  test('forwards prompt text into the $ARGUMENTS template', async () => {
    const { commands, prompts } = await setupV2()
    await commands[0].execute({
      sessionID: 'sess-cmd',
      prompt: { text: 'feature-x' },
      delivery: 'steer',
    })

    assert.strictEqual(prompts.length, 1)
    assert.match(prompts[0].text, /Call the `devcontainer` tool with `target` set to: feature-x/)
    assert.strictEqual(prompts[0].sessionID, 'sess-cmd')
    assert.strictEqual(prompts[0].delivery, 'steer')
  })

  test('inserts prompt text literally, not as a replacement pattern', async () => {
    const { commands, prompts } = await setupV2()
    // `$&` in a string replacement expands to the matched substring
    await commands[0].execute({
      sessionID: 'sess-cmd-literal',
      prompt: { text: 'feat/$&-x' },
      delivery: 'steer',
    })

    assert.strictEqual(prompts.length, 1)
    assert.ok(
      prompts[0].text.includes('target` set to: feat/$&-x'),
      'special replacement patterns must not be expanded'
    )
    assert.ok(!prompts[0].text.includes('$ARGUMENTS'), 'placeholder replaced')
  })

  test('empty arguments keep the status guidance', async () => {
    const { commands, prompts } = await setupV2()
    await commands[0].execute({
      sessionID: 'sess-cmd-empty',
      prompt: { text: '' },
      delivery: 'steer',
    })

    assert.match(prompts[0].text, /If no arguments provided, call `devcontainer` with no target/)
  })
})

// ============ devcontainer tool via V2 ============

describeIfPosix('devcontainer tool (V2)', () => {
  test('status: reports no active session', async () => {
    const { tools } = await setupV2()
    const result = await toolByName(tools, 'devcontainer').execute(
      {},
      { sessionID: sid('v2-status-none') }
    )
    assert.match(result.content, /No devcontainer active/)
  })

  test('targets a running clone and saves the session', async () => {
    const sessionID = sid('v2-target')
    const workspace = join(testDir, 'clones', 'runrepo', 'runbr')
    mkdirSync(join(workspace, '.devcontainer'), { recursive: true })
    writeFileSync(join(workspace, '.devcontainer', 'devcontainer.json'), JSON.stringify({ name: 'test' }))
    process.env.FAKE_DOCKER_RUNNING = '1'

    const { tools } = await setupV2()
    const result = await toolByName(tools, 'devcontainer').execute(
      { target: 'runrepo/runbr' },
      { sessionID }
    )
    assert.match(result.content, /Session now targeting: runrepo\/runbr/)

    const session = JSON.parse(readFileSync(join(testDir, 'sessions', `${sessionID}.json`), 'utf-8'))
    assert.strictEqual(session.workspace, workspace)
    assert.strictEqual(session.repoName, 'runrepo')
  })

  test('reports missing devcontainer CLI', async () => {
    // Remove the fake from PATH resolution by pointing at an empty dir first
    const original = process.env.PATH
    process.env.PATH = join(testDir, 'empty-bin')
    try {
      const { tools } = await setupV2()
      const result = await toolByName(tools, 'devcontainer').execute(
        { target: 'x' },
        { sessionID: sid('v2-nocli') }
      )
      assert.match(result.content, /devcontainer CLI not found/)
    } finally {
      process.env.PATH = original
    }
  })

  test('off: disables an active session', async () => {
    const sessionID = sid('v2-off')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/off' })

    const { tools } = await setupV2()
    const result = await toolByName(tools, 'devcontainer').execute(
      { target: 'off' },
      { sessionID }
    )
    assert.match(result.content, /disabled/)
    assert.ok(!existsSync(join(testDir, 'sessions', `${sessionID}.json`)), 'session file removed')
  })

  test('rm all: reports when there is nothing to clean up', async () => {
    const { tools } = await setupV2()
    const result = await toolByName(tools, 'devcontainer').execute(
      { target: 'rm all' },
      { sessionID: sid('v2-rmall-none') }
    )
    assert.match(result.content, /No devcontainers to clean up/)
  })

  test('starts a new branch in the background and settles', async () => {
    const sessionID = sid('v2-bg')
    const mainRepo = makeGitRepo(join(testDir, 'main-repo'))
    process.chdir(mainRepo)

    const { tools } = await setupV2()
    const result = await toolByName(tools, 'devcontainer').execute(
      { target: 'feature-x' },
      { sessionID }
    )
    assert.match(result.content, /Starting container for main-repo\/feature-x/)

    const session = JSON.parse(readFileSync(join(testDir, 'sessions', `${sessionID}.json`), 'utf-8'))
    assert.strictEqual(session.starting, true)

    // Background clone of a nonexistent branch must settle before teardown
    const status = await waitForJobSettled(session.workspace)
    assert.strictEqual(status, JOB_STATUS.FAILED)
  })
})

// ============ devcontainer_exec tool via V2 ============

describeIfPosix('devcontainer_exec tool (V2)', () => {
  test('errors without a devcontainer session', async () => {
    const { tools } = await setupV2()
    const result = await toolByName(tools, 'devcontainer_exec').execute(
      { command: 'echo hi' },
      { sessionID: sid('v2-exec-none') }
    )
    assert.match(result.content, /No devcontainer context set/)
  })

  test('runs the command inside the container', async () => {
    const sessionID = sid('v2-exec-run')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/exec' })

    const { tools } = await setupV2()
    const result = await toolByName(tools, 'devcontainer_exec').execute(
      { command: 'echo from-container' },
      { sessionID }
    )
    assert.strictEqual(result.content, 'from-container')
  })

  test('reports failure detail on non-zero exit', async () => {
    const sessionID = sid('v2-exec-fail')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/exec-fail' })

    const { tools } = await setupV2()
    const result = await toolByName(tools, 'devcontainer_exec').execute(
      { command: 'sh -c "exit 3"' },
      { sessionID }
    )
    assert.match(result.content, /Command failed \(exit 3\)/)
  })

  test('starting: reports while the job is still running', async () => {
    const sessionID = sid('v2-exec-starting')
    const workspace = '/ws/exec-starting'
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })
    writeJobs({ [workspace]: { status: JOB_STATUS.RUNNING, completedAt: new Date().toISOString(), repo: 'repo', branch: 'feat' } })

    const { tools } = await setupV2()
    const result = await toolByName(tools, 'devcontainer_exec').execute(
      { command: 'echo hi' },
      { sessionID }
    )
    assert.match(result.content, /Container is still starting/)
  })

  test('starting: clears the flag once the job completed', async () => {
    const sessionID = sid('v2-exec-ready')
    const workspace = '/ws/exec-ready'
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })
    writeJobs({ [workspace]: { status: JOB_STATUS.COMPLETED, port: 13000, completedAt: new Date().toISOString(), repo: 'repo', branch: 'feat' } })

    const { tools } = await setupV2()
    const result = await toolByName(tools, 'devcontainer_exec').execute(
      { command: 'echo ready' },
      { sessionID }
    )
    assert.strictEqual(result.content, 'ready')

    const session = JSON.parse(readFileSync(join(testDir, 'sessions', `${sessionID}.json`), 'utf-8'))
    assert.strictEqual(session.starting, false, 'starting flag cleared')
  })
})

// ============ shell interception hook via V2 ============

describeIfPosix('execute.before hook (V2)', () => {
  async function runHook(event) {
    const { hooks } = await setupV2()
    const hook = hookByName(hooks, 'execute.before')
    await hook.cb(event)
    return event
  }

  test('wraps commands for an active devcontainer session', async () => {
    const sessionID = sid('v2-hook-wrap')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/hook' })

    const event = await runHook({
      tool: 'shell',
      sessionID,
      input: { command: 'npm test', workdir: '/ws/hook' },
    })
    assert.match(event.input.command, /^devcontainer exec --workspace-folder \/ws\/hook -- npm test$/)
  })

  test('strips the HOST: escape prefix', async () => {
    const sessionID = sid('v2-hook-escape')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/escape' })

    const event = await runHook({
      tool: 'shell',
      sessionID,
      input: { command: 'HOST: docker ps' },
    })
    assert.strictEqual(event.input.command, 'docker ps')
  })

  test('leaves host-run commands untouched', async () => {
    const sessionID = sid('v2-hook-host')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/host' })

    const event = await runHook({
      tool: 'shell',
      sessionID,
      input: { command: 'git status' },
    })
    assert.strictEqual(event.input.command, 'git status')
  })

  test('leaves commands with a foreign workdir untouched', async () => {
    const sessionID = sid('v2-hook-foreign')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/foreign' })

    const event = await runHook({
      tool: 'shell',
      sessionID,
      input: { command: 'npm test', workdir: '/elsewhere' },
    })
    assert.strictEqual(event.input.command, 'npm test')
  })

  test('leaves non-shell tools untouched', async () => {
    const sessionID = sid('v2-hook-read')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/read' })

    const event = await runHook({
      tool: 'read',
      sessionID,
      input: { path: '/ws/read/file.txt' },
    })
    assert.strictEqual(event.input.path, '/ws/read/file.txt')
  })

  test('leaves sessions without a workspace untouched', async () => {
    const event = await runHook({
      tool: 'shell',
      sessionID: sid('v2-hook-nosession'),
      input: { command: 'npm test' },
    })
    assert.strictEqual(event.input.command, 'npm test')
  })

  test('leaves non-object input untouched', async () => {
    const event = await runHook({
      tool: 'shell',
      sessionID: sid('v2-hook-scalar'),
      input: 'npm test',
    })
    assert.strictEqual(event.input, 'npm test')
  })

  test('leaves V1-migrated worktree sessions alone (V2 has native worktrees)', async () => {
    const sessionID = sid('v2-hook-wt')
    saveSession(sessionID, { type: 'worktree', repoName: 'repo', branch: 'feat', workspace: '/ws/wt' })

    const event = await runHook({
      tool: 'shell',
      sessionID,
      input: { command: 'npm test' },
    })
    assert.strictEqual(event.input.workdir, undefined, 'stale V1 worktree state must not reroute commands')
    assert.strictEqual(event.input.command, 'npm test', 'command not wrapped')
  })

  test('rewrites to a helpful message while the container is starting', async () => {
    const sessionID = sid('v2-hook-starting')
    const workspace = '/ws/hook-starting'
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })
    writeJobs({ [workspace]: { status: JOB_STATUS.RUNNING, completedAt: new Date().toISOString(), repo: 'repo', branch: 'feat' } })

    const event = await runHook({
      tool: 'shell',
      sessionID,
      input: { command: 'npm test' },
    })
    assert.match(event.input.command, /^echo "Container is still starting for repo\/feat/)
    assert.match(event.input.command, /&& exit 1$/)
  })

  test('wraps and clears the starting flag once the container is ready', async () => {
    const sessionID = sid('v2-hook-ready')
    const workspace = '/ws/hook-ready'
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })
    writeJobs({ [workspace]: { status: JOB_STATUS.COMPLETED, port: 13000, completedAt: new Date().toISOString(), repo: 'repo', branch: 'feat' } })

    const event = await runHook({
      tool: 'shell',
      sessionID,
      input: { command: 'npm test' },
    })
    assert.match(event.input.command, /^devcontainer exec --workspace-folder \/ws\/hook-ready -- npm test$/)

    const session = JSON.parse(readFileSync(join(testDir, 'sessions', `${sessionID}.json`), 'utf-8'))
    assert.strictEqual(session.starting, false, 'starting flag cleared')
  })

  test('adds --override-config when an override file exists', async () => {
    const sessionID = sid('v2-hook-override')
    const workspace = '/ws/hook-override'
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace })
    // getOverridePath derives a per-workspace filename; create via the same helper
    writeFileSync(getOverridePath(workspace), '{}')

    const event = await runHook({
      tool: 'shell',
      sessionID,
      input: { command: 'npm test' },
    })
    assert.match(event.input.command, /--override-config/)
  })
})
