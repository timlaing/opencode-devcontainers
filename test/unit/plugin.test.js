/**
 * Tests for the V1 plugin implementation (server() on the combined
 * entrypoint in plugin/index.js, implemented in plugin/v1.js).
 *
 * Covers:
 * - The devcontainers() factory: returned shape and init side-effects
 *   (command installation, stale session cleanup, job cleanup)
 * - The devcontainer_exec, devcontainer, worktree, and workspaces tools
 * - The tool.execute.before bash interception hook
 *
 * External commands (devcontainer CLI, docker) are replaced with fake
 * executables on PATH so tests are hermetic and deterministic. Shared
 * harness lives in ./harness.js.
 *
 * Run with: node --test test/unit/plugin.test.js
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { join } from 'path'
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync,
} from 'fs'
import { execFileSync } from 'child_process'

// Module under test
import { devcontainers } from '../../plugin/index.js'
import { getOverridePath } from '../../plugin/core/config.js'
import { JOB_STATUS } from '../../plugin/core/jobs.js'
import { cleanupStaleSessions } from '../../plugin/handlers.js'
import { loadSession } from '../../plugin/helpers.js'

// Shared hermetic harness (testDir/fakeBin are live bindings)
import {
  testDir,
  sid, saveSession, writeSessionFile, writeJobs, waitFor, makeGitRepo,
  waitForJobSettled, makeFakeClient, activeSessions,
  setupEnv, teardownEnv,
} from './harness.js'

// The plugin resolves commands via `which` and runs them with `sh -c`, and
// the fake CLIs here are POSIX shell scripts — so this suite is POSIX-only.
const describeIfPosix = process.platform === 'win32' ? describe.skip : describe

beforeEach(setupEnv)
afterEach(teardownEnv)

/** Build the plugin via the factory with a fake client */
async function makePlugin(clientOpts = {}) {
  const sessions = clientOpts.sessions ?? activeSessions()
  return await devcontainers({ client: makeFakeClient({ sessions, ...clientOpts }) })
}

// ============ Factory ============

describeIfPosix('devcontainers factory', () => {
  test('returns all four tools and the interception hook', async () => {
    const plugin = await makePlugin()
    assert.ok(plugin.tool.devcontainer_exec, 'devcontainer_exec tool present')
    assert.ok(plugin.tool.devcontainer, 'devcontainer tool present')
    assert.ok(plugin.tool.worktree, 'worktree tool present')
    assert.ok(plugin.tool.workspaces, 'workspaces tool present')
    assert.strictEqual(typeof plugin['tool.execute.before'], 'function')
  })

  test('installs command files into the config command dir', async () => {
    const configDir = join(testDir, 'config')
    await makePlugin({ configDir })

    const commandDir = join(configDir, 'command')
    const installed = await waitFor(() => existsSync(join(commandDir, 'devcontainer.md')))
    assert.ok(installed, 'devcontainer.md copied')
    assert.ok(existsSync(join(commandDir, 'worktree.md')), 'worktree.md copied')
    assert.ok(existsSync(join(commandDir, 'workspaces.md')), 'workspaces.md copied')
  })

  test('removes legacy command file names', async () => {
    const configDir = join(testDir, 'config')
    const commandDir = join(configDir, 'command')
    mkdirSync(commandDir, { recursive: true })
    writeFileSync(join(commandDir, 'ocdc.md'), 'old')
    writeFileSync(join(commandDir, 'ocdc-use.md'), 'old')

    await makePlugin({ configDir })

    const cleaned = await waitFor(() =>
      !existsSync(join(commandDir, 'ocdc.md')) && !existsSync(join(commandDir, 'ocdc-use.md')))
    assert.ok(cleaned, 'legacy command files removed')
  })

  test('tolerates client.path.get failure', async () => {
    await assert.doesNotReject(() => makePlugin({ failPaths: true }))
  })

  test('skips command install when no config dir is returned', async () => {
    await makePlugin({ configDir: null })
    // Fire-and-forget should complete without creating anything under the cache
    const commandDir = join(testDir, 'config', 'command')
    await new Promise(r => setTimeout(r, 100))
    assert.ok(!existsSync(commandDir), 'no command dir created')
  })

  test('removes stale session files not returned by the API', async () => {
    const active = sid('active')
    const stale = sid('stale')
    writeSessionFile(active, { workspace: '/ws/a' })
    writeSessionFile(stale, { workspace: '/ws/b' })
    writeFileSync(join(testDir, 'sessions', 'notes.txt'), 'not a session')

    await makePlugin({ sessions: [{ id: active }] })

    const cleaned = await waitFor(() => !existsSync(join(testDir, 'sessions', `${stale}.json`)))
    assert.ok(cleaned, 'stale session removed')
    assert.ok(existsSync(join(testDir, 'sessions', `${active}.json`)), 'active session kept')
    assert.ok(existsSync(join(testDir, 'sessions', 'notes.txt')), 'non-json file kept')
  })

  test('tolerates session.list failure', async () => {
    const client = {
      path: { get: async () => ({ data: {} }) },
      session: { list: async () => { throw new Error('api unavailable') } },
    }
    await assert.doesNotReject(() => devcontainers({ client }))
  })

  test('cleans up old terminal jobs during init', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    writeJobs({
      '/ws/old-completed': { status: JOB_STATUS.COMPLETED, completedAt: old, repo: 'r', branch: 'b' },
      '/ws/fresh-running': { status: JOB_STATUS.RUNNING, startedAt: new Date().toISOString() },
    })

    await makePlugin()

    const cleaned = await waitFor(() => {
      if (!existsSync(join(testDir, 'cache', 'jobs.json'))) return false
      const jobs = JSON.parse(readFileSync(join(testDir, 'cache', 'jobs.json'), 'utf-8'))
      return !jobs['/ws/old-completed'] && jobs['/ws/fresh-running']
    })
    assert.ok(cleaned, 'old completed job removed, running job kept')
  })
})

// ============ devcontainer_exec tool ============

describeIfPosix('devcontainer_exec tool', () => {
  test('errors without a session workspace', async () => {
    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer_exec.execute(
      { command: 'ls' },
      { sessionID: sid('none') }
    )
    assert.match(result, /No devcontainer context set/)
  })

  test('reports container still starting (pending job)', async () => {
    const sessionID = sid('starting-pending')
    const workspace = '/ws/start-pending'
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })
    writeJobs({ [workspace]: { status: JOB_STATUS.PENDING, repo: 'repo', branch: 'feat' } })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer_exec.execute(
      { command: 'ls' },
      { sessionID }
    )
    assert.match(result, /still starting/)
    assert.match(result, /repo\/feat/)
  })

  test('reports container still starting (running job)', async () => {
    const sessionID = sid('starting-running')
    const workspace = '/ws/start-running'
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })
    writeJobs({ [workspace]: { status: JOB_STATUS.RUNNING, repo: 'repo', branch: 'feat' } })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer_exec.execute(
      { command: 'ls' },
      { sessionID }
    )
    assert.match(result, /still starting/)
  })

  test('reports failed container start', async () => {
    const sessionID = sid('starting-failed')
    const workspace = '/ws/start-failed'
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })
    writeJobs({ [workspace]: { status: JOB_STATUS.FAILED, error: 'boom', completedAt: new Date().toISOString(), repo: 'repo', branch: 'feat' } })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer_exec.execute(
      { command: 'ls' },
      { sessionID }
    )
    assert.match(result, /failed to start: boom/)
    assert.match(result, /retry/)
  })

  test('clears starting flag once job completes, then executes', async () => {
    const sessionID = sid('starting-done')
    const workspace = join(testDir, 'ws-done')
    mkdirSync(workspace, { recursive: true })
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })
    writeJobs({ [workspace]: { status: JOB_STATUS.COMPLETED, port: 13000, completedAt: new Date().toISOString(), repo: 'repo', branch: 'feat' } })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer_exec.execute(
      { command: 'echo hello-from-container' },
      { sessionID }
    )
    assert.strictEqual(result.trim(), 'hello-from-container')

    const session = JSON.parse(readFileSync(join(testDir, 'sessions', `${sessionID}.json`), 'utf-8'))
    assert.strictEqual(session.starting, false, 'starting flag cleared')
  })

  test('passes through successful command output', async () => {
    const sessionID = sid('exec-ok')
    const workspace = join(testDir, 'ws-ok')
    mkdirSync(workspace, { recursive: true })
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer_exec.execute(
      { command: 'echo plain-output' },
      { sessionID }
    )
    assert.strictEqual(result.trim(), 'plain-output')
  })

  test('reports non-zero exit codes', async () => {
    const sessionID = sid('exec-fail')
    const workspace = join(testDir, 'ws-fail')
    mkdirSync(workspace, { recursive: true })
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer_exec.execute(
      { command: 'echo oops >&2; exit 3' },
      { sessionID }
    )
    assert.match(result, /Command failed \(exit 3\)/)
    assert.match(result, /oops/)
  })

  test('reports cancellation on abort', async () => {
    const sessionID = sid('exec-abort')
    const workspace = join(testDir, 'ws-abort')
    mkdirSync(workspace, { recursive: true })
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace })

    const plugin = await makePlugin()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)

    const result = await plugin.tool.devcontainer_exec.execute(
      { command: 'sleep 5' },
      { sessionID, abort: controller.signal }
    )
    assert.match(result, /Command cancelled/)
  })

  test('reports spawn failures as command failure', async () => {
    const sessionID = sid('exec-enosent')
    const workspace = join(testDir, 'ws-enosent')
    mkdirSync(workspace, { recursive: true })
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace })

    // Hide the fake devcontainer so spawn fails with ENOENT
    process.env.PATH = join(testDir, 'empty-bin')
    mkdirSync(process.env.PATH, { recursive: true })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer_exec.execute(
      { command: 'echo never' },
      { sessionID }
    )
    assert.match(result, /Command failed: /)
  })
})

// ============ devcontainer tool ============

describeIfPosix('devcontainer tool', () => {
  test('reports missing devcontainer CLI', async () => {
    process.env.PATH = join(testDir, 'empty-bin')
    mkdirSync(process.env.PATH, { recursive: true })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute({}, { sessionID: sid('no-cli') })
    assert.match(result, /devcontainer CLI not found/)
    assert.match(result, /npm install -g/)
  })

  test('off works without the devcontainer CLI', async () => {
    process.env.PATH = join(testDir, 'empty-bin')
    mkdirSync(process.env.PATH, { recursive: true })

    const sessionID = sid('off-no-cli')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/off-no-cli' })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute({ target: 'off' }, { sessionID })
    assert.doesNotMatch(result, /CLI not found/, 'off is session-only and needs no CLI')
    assert.match(result, /Devcontainer mode disabled/)
    assert.strictEqual(loadSession(sessionID), null, 'session cleared')
  })

  test('rm works without the devcontainer CLI', async () => {
    process.env.PATH = join(testDir, 'empty-bin')
    mkdirSync(process.env.PATH, { recursive: true })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'rm all' },
      { sessionID: sid('rm-no-cli') }
    )
    assert.doesNotMatch(result, /CLI not found/, 'rm needs docker (validated by core), not the devcontainer CLI')
    assert.match(result, /No devcontainers to clean up/)
  })

  test('status: no session', async () => {
    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute({}, { sessionID: sid('status-none') })
    assert.match(result, /No devcontainer active/)
  })

  test('status: starting with pending job', async () => {
    const sessionID = sid('status-pending')
    const workspace = '/ws/status-pending'
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })
    writeJobs({ [workspace]: { status: JOB_STATUS.PENDING, repo: 'repo', branch: 'feat' } })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute({}, { sessionID })
    assert.match(result, /Starting \(pending\)/)
  })

  test('status: starting with running job', async () => {
    const sessionID = sid('status-running')
    const workspace = '/ws/status-running'
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })
    writeJobs({ [workspace]: { status: JOB_STATUS.RUNNING, repo: 'repo', branch: 'feat' } })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute({}, { sessionID })
    assert.match(result, /Starting \(in progress\)/)
  })

  test('status: starting with failed job', async () => {
    const sessionID = sid('status-failed')
    const workspace = '/ws/status-failed'
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })
    writeJobs({ [workspace]: { status: JOB_STATUS.FAILED, error: 'kaboom', completedAt: new Date().toISOString(), repo: 'repo', branch: 'feat' } })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute({}, { sessionID })
    assert.match(result, /Failed to start/)
    assert.match(result, /kaboom/)
  })

  test('status: starting with completed job clears flag and reports ready', async () => {
    const sessionID = sid('status-completed')
    const workspace = '/ws/status-completed'
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })
    writeJobs({ [workspace]: { status: JOB_STATUS.COMPLETED, port: 13042, completedAt: new Date().toISOString(), repo: 'repo', branch: 'feat' } })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute({}, { sessionID })
    assert.match(result, /Container is ready/)
    assert.match(result, /Port: 13042/)

    const session = JSON.parse(readFileSync(join(testDir, 'sessions', `${sessionID}.json`), 'utf-8'))
    assert.strictEqual(session.starting, false, 'starting flag cleared')
  })

  test('status: starting with missing job falls through to running check', async () => {
    const sessionID = sid('status-nojob')
    const workspace = '/ws/status-nojob'
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute({}, { sessionID })
    assert.match(result, /Not running/)
  })

  test('status: reports running container', async () => {
    const sessionID = sid('status-isrunning')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/running' })
    process.env.FAKE_DOCKER_RUNNING = '1'

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute({}, { sessionID })
    assert.match(result, /Current devcontainer: repo\/feat/)
    assert.match(result, /Status: Running/)
  })

  test('off: disables an active session', async () => {
    const sessionID = sid('off-active')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/off' })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute({ target: 'off' }, { sessionID })
    assert.match(result, /disabled/)
    assert.ok(!existsSync(join(testDir, 'sessions', `${sessionID}.json`)), 'session file removed')
  })

  test('off: reports when nothing was active', async () => {
    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute({ target: 'off' }, { sessionID: sid('off-none') })
    assert.match(result, /No devcontainer was active/)
  })

  test('rm: shows usage without an argument', async () => {
    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute({ target: 'rm ' }, { sessionID: sid('rm-usage') })
    assert.match(result, /Usage: `\/devcontainer rm <branch>`/)
  })

  test('rm: reports when no devcontainer matches the branch', async () => {
    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'rm nope' },
      { sessionID: sid('rm-none') }
    )
    assert.match(result, /No devcontainer found for branch 'nope'/)
  })

  test('rm: reports ambiguous branch across repos', async () => {
    mkdirSync(join(testDir, 'clones', 'repo-a', 'dup'), { recursive: true })
    mkdirSync(join(testDir, 'clones', 'repo-b', 'dup'), { recursive: true })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'rm dup' },
      { sessionID: sid('rm-ambig') }
    )
    assert.match(result, /Ambiguous branch 'dup' found in multiple repos/)
    assert.match(result, /repo-a\/dup/)
    assert.match(result, /repo-b\/dup/)
  })

  test('rm: warns about uncommitted changes and other sessions, requires confirmation', async () => {
    const sessionID = sid('rm-warn')
    const workspace = join(testDir, 'clones', 'warnrepo', 'warnbr')
    makeGitRepo(workspace)
    writeFileSync(join(workspace, 'dirty.txt'), 'uncommitted')

    const otherID = sid('other')
    writeSessionFile(otherID, { workspace })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'rm warnrepo/warnbr' },
      { sessionID }
    )
    assert.match(result, /uncommitted changes/)
    assert.match(result, /active in other sessions/)
    assert.match(result, /explicit user confirmation required/)
    assert.ok(existsSync(workspace), 'workspace not removed without confirmation')
  })

  test('rm: removes workspace and clears matching session when confirmed', async () => {
    const sessionID = sid('rm-confirm')
    const workspace = join(testDir, 'clones', 'rmrepo', 'rmbr')
    makeGitRepo(workspace)
    saveSession(sessionID, { repoName: 'rmrepo', branch: 'rmbr', workspace })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'rm rmrepo/rmbr', confirmed: true },
      { sessionID }
    )
    assert.match(result, /Removed devcontainer: rmrepo\/rmbr/)
    assert.match(result, /- Container: not found/)
    assert.match(result, /- Port: released/)
    assert.match(result, /- Clone folder: deleted/)
    assert.ok(!existsSync(workspace), 'clone removed')
    assert.ok(!existsSync(join(testDir, 'sessions', `${sessionID}.json`)), 'session cleared')
  })

  test('rm: reports container and image removal when docker has a match', async () => {
    const workspace = join(testDir, 'clones', 'ctrrepo', 'ctrbr')
    makeGitRepo(workspace)
    process.env.FAKE_DOCKER_RUNNING = '1'
    process.env.FAKE_DOCKER_IMAGE = '1'

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'rm ctrrepo/ctrbr', confirmed: true },
      { sessionID: sid('rm-ctr') }
    )
    assert.match(result, /- Container: stopped and removed/)
    assert.match(result, /- Image: removed/)
  })

  test('rm all: reports when there is nothing to clean up', async () => {
    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'rm all' },
      { sessionID: sid('rmall-none') }
    )
    assert.match(result, /No devcontainers to clean up/)
  })

  test('rm all: warns before removal when unconfirmed', async () => {
    const workspace = join(testDir, 'clones', 'allrepo', 'allbr')
    makeGitRepo(workspace)
    writeFileSync(join(workspace, 'dirty.txt'), 'uncommitted')

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'rm all' },
      { sessionID: sid('rmall-warn') }
    )
    assert.match(result, /uncommitted changes/)
    assert.match(result, /Reply "yes" to confirm/)
    assert.ok(existsSync(workspace), 'workspace not removed without confirmation')
  })

  test('rm all: removes clones, port entries, and job entries', async () => {
    const sessionID = sid('rmall-confirm')
    const cloneWs = join(testDir, 'clones', 'multi', 'one')
    makeGitRepo(cloneWs)
    const orphanWs = '/ws/orphan-from-ports'

    writeFileSync(join(testDir, 'cache', 'ports.json'), JSON.stringify({
      [orphanWs]: { port: 13001, repo: 'orphan', branch: 'two' },
    }))
    writeJobs({
      [orphanWs]: { status: JOB_STATUS.RUNNING, repo: 'orphan', branch: 'two' },
      '/ws/other-job': { status: JOB_STATUS.RUNNING, repo: 'other', branch: 'three' },
    })
    writeSessionFile(sid('rmall-other'), { workspace: cloneWs })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'rm all', confirmed: true },
      { sessionID }
    )
    // Entries come from clones (multi/one), ports (orphan/two), and jobs
    // (orphan/two deduped, plus other/three)
    assert.match(result, /Removing 3 devcontainer\(s\)/)
    assert.match(result, /Done\. 0 error\(s\)/)
    assert.ok(!existsSync(cloneWs), 'clone removed')

    const ports = JSON.parse(readFileSync(join(testDir, 'cache', 'ports.json'), 'utf-8'))
    assert.ok(!ports[orphanWs], 'orphan port entry removed')

    const jobs = JSON.parse(readFileSync(join(testDir, 'cache', 'jobs.json'), 'utf-8'))
    assert.ok(!jobs[orphanWs], 'orphan job entry removed')
    assert.ok(!jobs['/ws/other-job'], 'job-only entry removed')
  })

  test('rm: clears cached session state for the removed workspace', async () => {
    const sessionID = sid('rmcache-current')
    const otherID = sid('rmcache-other')
    const cloneWs = join(testDir, 'clones', 'rmcache', 'rmbr')
    makeGitRepo(cloneWs)

    saveSession(sessionID, { repoName: 'rmcache', branch: 'rmbr', workspace: cloneWs })
    saveSession(otherID, { repoName: 'rmcache', branch: 'rmbr', workspace: cloneWs })
    // Prime the in-process cache for the other session
    assert.ok(loadSession(otherID), 'other session cached')

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'rm rmcache/rmbr', confirmed: true },
      { sessionID }
    )
    assert.match(result, /Removed devcontainer: rmcache\/rmbr/)

    // Core cleanup deleted the session files; the in-process cache must be
    // invalidated too, or loadSession keeps routing the other session to the
    // removed workspace
    assert.ok(!existsSync(join(testDir, 'sessions', `${otherID}.json`)), 'session file removed')
    assert.strictEqual(loadSession(otherID), null, 'cached state invalidated')
  })

  test('target: starts a new container in the background for an unknown branch', async () => {
    const sessionID = sid('new-branch')
    const mainRepo = makeGitRepo(join(testDir, 'main-repo'))
    process.chdir(mainRepo)

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'feature-x' },
      { sessionID }
    )
    assert.match(result, /Starting container for main-repo\/feature-x/)
    assert.match(result, /in the background/)

    const session = JSON.parse(readFileSync(join(testDir, 'sessions', `${sessionID}.json`), 'utf-8'))
    assert.strictEqual(session.starting, true, 'session marked as starting')
    assert.strictEqual(session.branch, 'feature-x')

    // Let the background up() finish (clone fails: branch doesn't exist) so
    // teardown doesn't remove the temp dirs/env out from under it
    const status = await waitForJobSettled(session.workspace)
    assert.strictEqual(status, JOB_STATUS.FAILED, 'background job settles as failed')
  })

  test('target: reports validation failure for a new branch outside a git repo', async () => {
    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'feature-x' },
      { sessionID: sid('new-norepo') }
    )
    assert.match(result, /Cannot create devcontainer for 'feature-x'/)
    assert.match(result, /Not in a git repository/)
  })

  test('target: reports failure detail when create is requested', async () => {
    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'feature-x', create: 'true' },
      { sessionID: sid('new-create') }
    )
    assert.match(result, /Failed to create workspace: /)
  })

  test('target: reports ambiguous branch across repos', async () => {
    mkdirSync(join(testDir, 'clones', 'repo-a', 'dup2'), { recursive: true })
    mkdirSync(join(testDir, 'clones', 'repo-b', 'dup2'), { recursive: true })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'dup2' },
      { sessionID: sid('target-ambig') }
    )
    assert.match(result, /Ambiguous branch 'dup2' found in multiple repos/)
    assert.match(result, /Use `\/devcontainer <repo>\/dup2`/)
  })

  test('target: starts a stopped clone in the background', async () => {
    const sessionID = sid('stopped-clone')
    const workspace = join(testDir, 'clones', 'stoppedrepo', 'stoppedbr')
    mkdirSync(join(workspace, '.devcontainer'), { recursive: true })
    writeFileSync(join(workspace, '.devcontainer', 'devcontainer.json'), JSON.stringify({ name: 'test' }))

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'stoppedrepo/stoppedbr' },
      { sessionID }
    )
    assert.match(result, /Starting container for stoppedrepo\/stoppedbr/)
    assert.match(result, /starting in the background/)

    const session = JSON.parse(readFileSync(join(testDir, 'sessions', `${sessionID}.json`), 'utf-8'))
    assert.strictEqual(session.starting, true, 'session marked as starting')

    // Let the background up() finish against the fake CLI so teardown
    // doesn't remove the temp dirs/env out from under it
    await waitForJobSettled(workspace)
  })

  test('target: reports missing devcontainer.json for a stopped clone', async () => {
    const workspace = join(testDir, 'clones', 'norepo', 'nobr')
    mkdirSync(workspace, { recursive: true })

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'norepo/nobr' },
      { sessionID: sid('stopped-nojson') }
    )
    assert.match(result, /Failed to start container: No devcontainer\.json found/)
  })

  test('target: targets a running clone and saves the session', async () => {
    const sessionID = sid('target-running')
    const workspace = join(testDir, 'clones', 'runrepo', 'runbr')
    mkdirSync(join(workspace, '.devcontainer'), { recursive: true })
    writeFileSync(join(workspace, '.devcontainer', 'devcontainer.json'), JSON.stringify({ name: 'test' }))
    process.env.FAKE_DOCKER_RUNNING = '1'

    const plugin = await makePlugin()
    const result = await plugin.tool.devcontainer.execute(
      { target: 'runrepo/runbr' },
      { sessionID }
    )
    assert.match(result, /Session now targeting: runrepo\/runbr/)

    const session = JSON.parse(readFileSync(join(testDir, 'sessions', `${sessionID}.json`), 'utf-8'))
    assert.strictEqual(session.workspace, workspace)
    assert.strictEqual(session.repoName, 'runrepo')
  })
})

// ============ worktree tool ============

describeIfPosix('worktree tool', () => {
  test('status: no session', async () => {
    const plugin = await makePlugin()
    const result = await plugin.tool.worktree.execute({}, { sessionID: sid('wt-none') })
    assert.match(result, /No workspace active/)
  })

  test('status: reports when session targets a devcontainer', async () => {
    const sessionID = sid('wt-devcontainer')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/x' })

    const plugin = await makePlugin()
    const result = await plugin.tool.worktree.execute({}, { sessionID })
    assert.match(result, /targeting a devcontainer, not a worktree/)
  })

  test('status: reports active worktree details', async () => {
    const sessionID = sid('wt-status')
    saveSession(sessionID, {
      type: 'worktree', repoName: 'repo', branch: 'feat',
      workspace: '/ws/wt', mainRepo: '/ws/main',
    })

    const plugin = await makePlugin()
    const result = await plugin.tool.worktree.execute({}, { sessionID })
    assert.match(result, /Current worktree: repo\/feat/)
    assert.match(result, /Main repo: \/ws\/main/)
  })

  test('off: disables an active worktree session', async () => {
    const sessionID = sid('wt-off')
    saveSession(sessionID, {
      type: 'worktree', repoName: 'repo', branch: 'feat',
      workspace: '/ws/wt', mainRepo: '/ws/main',
    })

    const plugin = await makePlugin()
    const result = await plugin.tool.worktree.execute({ target: 'off' }, { sessionID })
    assert.match(result, /Worktree mode disabled/)
    assert.ok(!existsSync(join(testDir, 'sessions', `${sessionID}.json`)), 'session file removed')
  })

  test('off: clears a devcontainer session with a note', async () => {
    const sessionID = sid('wt-off-dc')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/x' })

    const plugin = await makePlugin()
    const result = await plugin.tool.worktree.execute({ target: 'off' }, { sessionID })
    assert.match(result, /devcontainer, not a worktree/)
    assert.match(result, /Session cleared/)
  })

  test('off: reports when nothing was active', async () => {
    const plugin = await makePlugin()
    const result = await plugin.tool.worktree.execute({ target: 'off' }, { sessionID: sid('wt-off-none') })
    assert.match(result, /No workspace was active/)
  })

  test('rejects when workdir is not a git repository', async () => {
    const plugin = await makePlugin()
    const result = await plugin.tool.worktree.execute(
      { target: 'feat', workdir: join(testDir, 'not-a-repo') },
      { sessionID: sid('wt-norepo') }
    )
    assert.match(result, /Not in a git repository/)
    assert.match(result, /workdir/)
  })

  test('rejects when already inside a worktree', async () => {
    const mainRepo = makeGitRepo(join(testDir, 'wt-main'))
    const wtPath = join(testDir, 'existing-wt')
    execFileSync('git', ['worktree', 'add', '-b', 'existing-branch', wtPath], { cwd: mainRepo })

    const plugin = await makePlugin()
    const result = await plugin.tool.worktree.execute(
      { target: 'new-branch', workdir: wtPath },
      { sessionID: sid('wt-inwt') }
    )
    assert.match(result, /Already in a worktree/)
  })

  test('targets an existing worktree workspace', async () => {
    const sessionID = sid('wt-existing')
    const mainRepo = makeGitRepo(join(testDir, 'existing-main'))
    const wtWorkspace = join(testDir, 'worktrees', 'existing-main', 'feat-y')
    mkdirSync(join(mainRepo, '.git', 'worktrees', 'feat-y'), { recursive: true })
    mkdirSync(wtWorkspace, { recursive: true })
    writeFileSync(join(wtWorkspace, '.git'), `gitdir: ${mainRepo}/.git/worktrees/feat-y\n`)

    const plugin = await makePlugin()
    const result = await plugin.tool.worktree.execute(
      { target: 'existing-main/feat-y', workdir: mainRepo },
      { sessionID }
    )
    assert.match(result, /Session now targeting worktree: existing-main\/feat-y/)

    const session = JSON.parse(readFileSync(join(testDir, 'sessions', `${sessionID}.json`), 'utf-8'))
    assert.strictEqual(session.type, 'worktree')
    assert.strictEqual(session.workspace, wtWorkspace)
    assert.strictEqual(session.mainRepo, mainRepo)
  })

  test('reports ambiguous worktree branch across repos', async () => {
    const mainRepo = makeGitRepo(join(testDir, 'amb-main'))
    for (const repo of ['amb-a', 'amb-b']) {
      const wt = join(testDir, 'worktrees', repo, 'dup-wt')
      mkdirSync(join(mainRepo, '.git', 'worktrees', `${repo}-dup-wt`), { recursive: true })
      mkdirSync(wt, { recursive: true })
      writeFileSync(join(wt, '.git'), `gitdir: ${mainRepo}/.git/worktrees/${repo}-dup-wt\n`)
    }

    const plugin = await makePlugin()
    const result = await plugin.tool.worktree.execute(
      { target: 'dup-wt', workdir: mainRepo },
      { sessionID: sid('wt-ambig') }
    )
    assert.match(result, /Ambiguous branch 'dup-wt' found in multiple repos/)
  })

  test('creates a new worktree and saves the session', async () => {
    const sessionID = sid('wt-create')
    const mainRepo = makeGitRepo(join(testDir, 'create-main'))

    const plugin = await makePlugin()
    const result = await plugin.tool.worktree.execute(
      { target: 'feature-y', workdir: mainRepo },
      { sessionID }
    )
    assert.match(result, /Created worktree for create-main\/feature-y/)

    const session = JSON.parse(readFileSync(join(testDir, 'sessions', `${sessionID}.json`), 'utf-8'))
    assert.strictEqual(session.type, 'worktree')
    assert.strictEqual(session.branch, 'feature-y')
    assert.strictEqual(session.mainRepo, mainRepo)
    assert.ok(existsSync(join(session.workspace, '.git')), 'worktree checked out')
  })

  test('reports worktree creation failure', async () => {
    const mainRepo = makeGitRepo(join(testDir, 'fail-main'))

    const plugin = await makePlugin()
    const result = await plugin.tool.worktree.execute(
      { target: 'bad..branch', workdir: mainRepo },
      { sessionID: sid('wt-fail') }
    )
    assert.match(result, /Failed to create worktree: /)
  })
})

// ============ workspaces tool ============

describeIfPosix('workspaces tool', () => {
  test('lists nothing when no workspaces exist', async () => {
    const plugin = await makePlugin()
    const result = await plugin.tool.workspaces.execute({}, {})
    assert.match(result, /No workspaces found/)
  })

  test('lists clones and worktrees grouped by type', async () => {
    const cloneWs = join(testDir, 'clones', 'listrepo', 'listbr')
    makeGitRepo(cloneWs)

    const mainRepo = join(testDir, 'list-main')
    mkdirSync(mainRepo, { recursive: true })
    const wt = join(testDir, 'worktrees', 'listrepo', 'wtbr')
    mkdirSync(join(mainRepo, '.git', 'worktrees', 'wtbr'), { recursive: true })
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${mainRepo}/.git/worktrees/wtbr\n`)

    const plugin = await makePlugin()
    const result = await plugin.tool.workspaces.execute({}, {})
    assert.match(result, /Found 2 workspace\(s\)/)
    assert.match(result, /Devcontainer Clones.*1\):/)
    assert.match(result, /Worktrees.*1\):/)
    assert.match(result, /\[clone\] listrepo\/listbr/)
    assert.match(result, /\[worktree\] listrepo\/wtbr/)
  })

  test('cleanup: reports when nothing is stale', async () => {
    makeGitRepo(join(testDir, 'clones', 'freshrepo', 'freshbr'))

    const plugin = await makePlugin()
    const result = await plugin.tool.workspaces.execute({ action: 'cleanup' }, {})
    assert.match(result, /No stale workspaces found/)
  })

  test('cleanup: lists stale workspaces with warnings', async () => {
    const staleWs = join(testDir, 'clones', 'stalerepo', 'stalebr')
    makeGitRepo(staleWs)
    writeFileSync(join(staleWs, 'dirty.txt'), 'uncommitted')
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    utimesSync(staleWs, tenDaysAgo, tenDaysAgo)

    const plugin = await makePlugin()
    const result = await plugin.tool.workspaces.execute({ action: 'cleanup' }, {})
    assert.match(result, /Found 1 stale workspace\(s\)/)
    assert.match(result, /\[clone\] stalerepo\/stalebr/)
    assert.match(result, /uncommitted/)
    assert.match(result, /Path: /)
    assert.match(result, /To remove a workspace:/)
  })
})

// ============ cleanupStaleSessions (shared handler) ============

describeIfPosix('cleanupStaleSessions', () => {
  test('keeps a session saved after the initial snapshot', async () => {
    const sessionID = sid('stale-revalidated')
    writeSessionFile(sessionID, { workspace: '/ws/x' })

    let calls = 0
    await cleanupStaleSessions(async () => {
      calls++
      // First call is the snapshot (session not yet active); the
      // pre-unlink revalidation sees it as live
      return calls === 1 ? [] : [sessionID]
    })

    assert.ok(existsSync(join(testDir, 'sessions', `${sessionID}.json`)), 'session kept')
  })

  test('removes sessions absent from every live check', async () => {
    const sessionID = sid('stale-gone')
    writeSessionFile(sessionID, { workspace: '/ws/x' })

    await cleanupStaleSessions(async () => [])

    assert.ok(!existsSync(join(testDir, 'sessions', `${sessionID}.json`)), 'session removed')
  })
})

// ============ tool.execute.before (bash interception) ============

describeIfPosix('tool.execute.before', () => {
  async function intercept(plugin, { tool = 'bash', sessionID, command, workdir }) {
    const input = { tool, sessionID }
    const output = { args: { command, workdir } }
    await plugin['tool.execute.before'](input, output)
    return output
  }

  test('ignores non-bash tools', async () => {
    const sessionID = sid('hook-other-tool')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/x' })

    const plugin = await makePlugin()
    const output = await intercept(plugin, { tool: 'devcontainer_exec', sessionID, command: 'echo hi' })
    assert.strictEqual(output.args.command, 'echo hi', 'command unchanged')
  })

  test('ignores commands without an active session', async () => {
    const plugin = await makePlugin()
    const output = await intercept(plugin, { sessionID: sid('hook-none'), command: 'echo hi' })
    assert.strictEqual(output.args.command, 'echo hi', 'command unchanged')
  })

  test('ignores when workdir is outside the workspace', async () => {
    const sessionID = sid('hook-outside')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/x' })

    const plugin = await makePlugin()
    const output = await intercept(plugin, { sessionID, command: 'echo hi', workdir: '/somewhere/else' })
    assert.strictEqual(output.args.command, 'echo hi', 'command unchanged')
  })

  test('ignores when workdir is a sibling sharing the workspace prefix', async () => {
    const sessionID = sid('hook-sibling')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/x' })

    const plugin = await makePlugin()
    const output = await intercept(plugin, { sessionID, command: 'npm test', workdir: '/ws/x-evil' })
    assert.strictEqual(output.args.command, 'npm test', 'prefix sibling is outside the workspace')
  })

  test('intercepts when workdir equals or lies inside the workspace', async () => {
    const sessionID = sid('hook-inside')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/x' })

    const plugin = await makePlugin()
    const equal = await intercept(plugin, { sessionID, command: 'npm test', workdir: '/ws/x' })
    assert.match(equal.args.command, /devcontainer exec/, 'exact workspace path intercepted')

    const nested = await intercept(plugin, { sessionID, command: 'npm test', workdir: '/ws/x/sub' })
    assert.match(nested.args.command, /devcontainer exec/, 'nested path intercepted')
  })

  test('ignores empty commands', async () => {
    const sessionID = sid('hook-empty')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/x' })

    const plugin = await makePlugin()
    const output = await intercept(plugin, { sessionID, command: '   ' })
    assert.strictEqual(output.args.command, '   ', 'command unchanged')
  })

  test('strips the HOST: escape prefix and runs on host', async () => {
    const sessionID = sid('hook-host')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/x' })

    const plugin = await makePlugin()
    const output = await intercept(plugin, { sessionID, command: 'HOST: docker ps' })
    assert.strictEqual(output.args.command, 'docker ps', 'prefix stripped')
  })

  test('leaves host commands untouched', async () => {
    const sessionID = sid('hook-git')
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace: '/ws/x' })

    const plugin = await makePlugin()
    const output = await intercept(plugin, { sessionID, command: 'git status' })
    assert.strictEqual(output.args.command, 'git status', 'git stays on host')
  })

  test('sets workdir for worktree sessions', async () => {
    const sessionID = sid('hook-worktree')
    const workspace = '/ws/wt-branch'
    saveSession(sessionID, {
      type: 'worktree', repoName: 'repo', branch: 'feat', workspace, mainRepo: '/ws/main',
    })

    const plugin = await makePlugin()
    const output = await intercept(plugin, { sessionID, command: 'npm test' })
    assert.strictEqual(output.args.workdir, workspace, 'workdir redirected')
    assert.strictEqual(output.args.command, 'npm test', 'command not wrapped')
  })

  test('rewrites command with a helpful error while container is still starting', async () => {
    const sessionID = sid('hook-starting')
    const workspace = '/ws/hook-starting'
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })
    writeJobs({ [workspace]: { status: JOB_STATUS.PENDING, repo: 'repo', branch: 'feat' } })

    const plugin = await makePlugin()
    const output = await intercept(plugin, { sessionID, command: 'npm test' })
    assert.match(output.args.command, /still starting for repo\/feat/)
    assert.match(output.args.command, /exit 1/)
  })

  test('wraps command in devcontainer exec for active sessions', async () => {
    const sessionID = sid('hook-wrap')
    const workspace = join(testDir, 'hook-ws')
    mkdirSync(workspace, { recursive: true })
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace })

    const plugin = await makePlugin()
    const output = await intercept(plugin, { sessionID, command: 'npm test' })
    assert.ok(output.args.command.startsWith('devcontainer exec --workspace-folder'))
    assert.ok(output.args.command.includes(workspace), 'workspace included')
    assert.ok(output.args.command.endsWith('-- npm test'), 'command appended verbatim')
    assert.ok(!output.args.command.includes('--override-config'), 'no override by default')
  })

  test('adds --override-config when an override file exists', async () => {
    const sessionID = sid('hook-override')
    const workspace = join(testDir, 'hook-override-ws')
    mkdirSync(workspace, { recursive: true })
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace })
    writeFileSync(getOverridePath(workspace), '{}')

    const plugin = await makePlugin()
    const output = await intercept(plugin, { sessionID, command: 'npm test' })
    assert.match(output.args.command, /--override-config/)
  })

  test('clears starting flag when the background job completed', async () => {
    const sessionID = sid('hook-started')
    const workspace = join(testDir, 'hook-started-ws')
    mkdirSync(workspace, { recursive: true })
    saveSession(sessionID, { repoName: 'repo', branch: 'feat', workspace, starting: true })
    writeJobs({ [workspace]: { status: JOB_STATUS.COMPLETED, port: 13000, completedAt: new Date().toISOString(), repo: 'repo', branch: 'feat' } })

    const plugin = await makePlugin()
    const output = await intercept(plugin, { sessionID, command: 'npm test' })
    assert.ok(output.args.command.startsWith('devcontainer exec'), 'wrapped after start completed')

    const session = JSON.parse(readFileSync(join(testDir, 'sessions', `${sessionID}.json`), 'utf-8'))
    assert.strictEqual(session.starting, false, 'starting flag cleared')
  })
})
