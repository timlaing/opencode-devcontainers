/**
 * Shared hermetic test harness for the plugin suites.
 *
 * Provides fake `devcontainer`/`docker` executables on PATH, isolated
 * OCDC_* environment variables pointing at a per-test temp directory, and
 * fixture helpers. Imported by plugin.test.js (V1) and plugin-v2.test.js (V2);
 * node's test runner gives each file its own process, so state never crosses
 * between suites.
 *
 * Not named *.test.js so `node --test test/unit/*.test.js` does not run it.
 */
import { join, delimiter } from 'path'
import { tmpdir } from 'os'
import {
  mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync,
  realpathSync,
} from 'fs'
import { execSync } from 'child_process'

import { saveSession as persistSession } from '../../plugin/helpers.js'
import { JOB_STATUS } from '../../plugin/core/jobs.js'

// Live bindings: test files import these and always see the current test's
// values after setupEnv() runs.
export let testDir
export let fakeBin

let originalPath
let originalCwd
let savedFakeEnv
let sessionCounter = 0

// Session IDs saved or written during a test. makePlugin()/fake ctx report
// these so factory-init cleanupStaleSessions keeps their files — otherwise
// file-removal assertions could pass for the wrong reason.
const activeSessionIDs = new Set()

/** Unique session ID per call — helpers.js keeps a module-level session cache */
export function sid(label) {
  return `test-${label}-${Date.now()}-${++sessionCounter}`
}

/** saveSession wrapper that also registers the ID as active for the fake client */
export function saveSession(sessionID, data) {
  activeSessionIDs.add(sessionID)
  return persistSession(sessionID, data)
}

/** All session IDs registered this test, for fake client session lists */
export function activeSessions() {
  return [...activeSessionIDs].map(id => ({ id }))
}

export function writeJobs(jobs) {
  writeFileSync(join(testDir, 'cache', 'jobs.json'), JSON.stringify(jobs, null, 2))
}

export function writeSessionFile(sessionID, data) {
  activeSessionIDs.add(sessionID)
  mkdirSync(join(testDir, 'sessions'), { recursive: true })
  writeFileSync(join(testDir, 'sessions', `${sessionID}.json`), JSON.stringify(data, null, 2))
}

/** Poll until fn() is true or timeout — for fire-and-forget init work */
export async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true
    await new Promise(r => setTimeout(r, 25))
  }
  return false
}

/** Create a small real git repo and return its root */
export function makeGitRepo(dir) {
  mkdirSync(dir, { recursive: true })
  execSync('git init -b main', { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# test repo\n')
  execSync('git add .', { cwd: dir })
  execSync('git -c user.email=test@example.com -c user.name=test commit -m init', { cwd: dir })
  return dir
}

/**
 * Wait for a background start job to reach a terminal state, so teardown
 * never yanks the temp dirs/env out from under a still-running upBackground.
 */
export async function waitForJobSettled(workspace, timeoutMs = 10000) {
  const jobsPath = join(testDir, 'cache', 'jobs.json')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (existsSync(jobsPath)) {
      const jobs = JSON.parse(readFileSync(jobsPath, 'utf-8'))
      const status = jobs[workspace]?.status
      if (status === JOB_STATUS.COMPLETED || status === JOB_STATUS.FAILED) return status
    }
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`background job for ${workspace} did not settle within ${timeoutMs}ms`)
}

/**
 * Fake devcontainer CLI:
 * - `exec ... -- sh -c CMD` runs CMD via sh, passing through output/exit code
 * - `up ...` exits 0 (or 1 when FAKE_DC_UP_FAIL is set)
 */
function installFakeDevcontainer() {
  const script = `#!/bin/sh
sub="$1"
if [ "$sub" = "exec" ]; then
  shift
  while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
  [ "$1" = "--" ] && shift
  exec "$@"
fi
if [ "$sub" = "up" ]; then
  if [ -n "$FAKE_DC_UP_FAIL" ]; then
    echo "devcontainer up failed" >&2
    exit 1
  fi
  exit 0
fi
exit 0
`
  const path = join(fakeBin, 'devcontainer')
  writeFileSync(path, script)
  chmodSync(path, 0o755)
}

/**
 * Fake docker CLI:
 * - `ps ...` prints a container ID only when FAKE_DOCKER_RUNNING is set
 * - `inspect ...` prints an image ref when FAKE_DOCKER_IMAGE is set
 * - everything else exits 0
 */
function installFakeDocker() {
  const script = `#!/bin/sh
sub="$1"
if [ "$sub" = "ps" ]; then
  if [ -n "$FAKE_DOCKER_RUNNING" ]; then
    echo "fakecontainer123"
  fi
  exit 0
fi
if [ "$sub" = "inspect" ]; then
  if [ -n "$FAKE_DOCKER_IMAGE" ]; then
    echo "fake-image:latest"
  fi
  exit 0
fi
exit 0
`
  const path = join(fakeBin, 'docker')
  writeFileSync(path, script)
  chmodSync(path, 0o755)
}

/** Minimal fake OpenCode V1 client for factory init tests */
export function makeFakeClient({ configDir, sessions = [], failPaths = false } = {}) {
  return {
    path: {
      get: async () => {
        if (failPaths) throw new Error('api unavailable')
        return { data: configDir ? { config: configDir } : {} }
      },
    },
    session: {
      list: async () => ({ data: sessions }),
    },
  }
}

/** Isolate the environment for one test */
export function setupEnv() {
  originalPath = process.env.PATH
  originalCwd = process.cwd()
  sessionCounter = 0
  activeSessionIDs.clear()

  // Snapshot and clear fake-CLI flags so inherited values don't skew results
  savedFakeEnv = {
    FAKE_DC_UP_FAIL: process.env.FAKE_DC_UP_FAIL,
    FAKE_DOCKER_RUNNING: process.env.FAKE_DOCKER_RUNNING,
    FAKE_DOCKER_IMAGE: process.env.FAKE_DOCKER_IMAGE,
  }
  delete process.env.FAKE_DC_UP_FAIL
  delete process.env.FAKE_DOCKER_RUNNING
  delete process.env.FAKE_DOCKER_IMAGE

  testDir = join(tmpdir(), `ocdc-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testDir, { recursive: true })
  // Resolve symlinks (macOS /var -> /private/var) so test paths match
  // what git reports from rev-parse --show-toplevel
  testDir = realpathSync(testDir)

  process.env.HOME = join(testDir, 'home')
  process.env.OCDC_CACHE_DIR = join(testDir, 'cache')
  process.env.OCDC_CLONES_DIR = join(testDir, 'clones')
  process.env.OCDC_WORKTREES_DIR = join(testDir, 'worktrees')
  process.env.OCDC_SESSIONS_DIR = join(testDir, 'sessions')
  process.env.OCDC_CONFIG_DIR = join(testDir, 'config')

  mkdirSync(process.env.HOME, { recursive: true })
  mkdirSync(process.env.OCDC_CACHE_DIR, { recursive: true })
  mkdirSync(process.env.OCDC_CLONES_DIR, { recursive: true })
  mkdirSync(process.env.OCDC_WORKTREES_DIR, { recursive: true })
  mkdirSync(process.env.OCDC_SESSIONS_DIR, { recursive: true })
  mkdirSync(process.env.OCDC_CONFIG_DIR, { recursive: true })
  mkdirSync(join(process.env.OCDC_CACHE_DIR, 'overrides'), { recursive: true })

  fakeBin = join(testDir, 'bin')
  mkdirSync(fakeBin, { recursive: true })
  installFakeDevcontainer()
  installFakeDocker()
  process.env.PATH = `${fakeBin}${delimiter}${originalPath}`

  // Run from a non-git directory so repo inference in resolveWorkspace and
  // getRepoRoot(cwd) can't reach the real project repository.
  process.chdir(testDir)
}

/** Restore the environment after one test */
export async function teardownEnv() {
  process.env.PATH = originalPath
  process.chdir(originalCwd)
  delete process.env.HOME
  delete process.env.OCDC_CACHE_DIR
  delete process.env.OCDC_CLONES_DIR
  delete process.env.OCDC_WORKTREES_DIR
  delete process.env.OCDC_SESSIONS_DIR
  delete process.env.OCDC_CONFIG_DIR
  // Restore any fake-CLI flags inherited from the outer environment
  for (const [key, value] of Object.entries(savedFakeEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  // Init cleanup and job cleanup are fire-and-forget by design and may
  // still be writing (e.g. lock dirs under cache/) when the test finishes —
  // retry briefly instead of failing the teardown
  const deadline = Date.now() + 3000
  for (;;) {
    try {
      rmSync(testDir, { recursive: true, force: true })
      return
    } catch (err) {
      if ((err.code !== 'ENOTEMPTY' && err.code !== 'EBUSY') || Date.now() > deadline) {
        throw err
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}
