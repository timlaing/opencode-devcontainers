import { 
  readFileSync, writeFileSync, mkdirSync, existsSync, 
  readdirSync, unlinkSync, statSync 
} from "node:fs"
import { join, basename, relative, isAbsolute, sep } from "node:path"
import { execSync } from "node:child_process"

// ============ Utility Functions ============

/**
 * Check that a path is strictly inside a parent directory.
 * Boundary-aware: '/ws' does not contain '/ws-sibling', and '..' segments
 * that resolve outside the parent are rejected.
 *
 * @param {string} parentDir - Containing directory (absolute)
 * @param {string} childPath - Path to test (absolute)
 * @returns {boolean}
 */
export function isInside(parentDir, childPath) {
  const rel = relative(parentDir, childPath)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Wraps a promise with a timeout. If the promise doesn't resolve within
 * the specified time, the timeout rejects with 'TIMEOUT'.
 */
export function withTimeout(promise, ms) {
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('TIMEOUT')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId))
}

/**
 * Runs an async function with a timeout, returning undefined on timeout or error.
 * Use this for fire-and-forget operations that shouldn't block.
 */
export async function runWithTimeout(fn, ms) {
  try {
    return await withTimeout(fn(), ms)
  } catch {
    return undefined
  }
}

// Directory getters - respect environment variables
/**
 * Resolve the cache directory, honoring the OCDC_CACHE_DIR override.
 *
 * @returns {string} Absolute path to the plugin cache directory
 */
export function getCacheDir() {
  return process.env.OCDC_CACHE_DIR || 
    join(process.env.HOME, ".cache/opencode-devcontainers")
}

/**
 * Resolve the session-state directory, honoring OCDC_SESSIONS_DIR.
 *
 * @returns {string} Absolute path to the sessions directory
 */
export function getSessionsDir() {
  return process.env.OCDC_SESSIONS_DIR || 
    join(getCacheDir(), "opencode-sessions")
}

/**
 * Resolve the clones directory, honoring OCDC_CLONES_DIR. Clones live
 * alongside opencode desktop worktrees for discoverability.
 *
 * @returns {string} Absolute path to the clones directory
 */
export function getClonesDir() {
  return process.env.OCDC_CLONES_DIR ||
    join(process.env.HOME, ".local/share/opencode/clone")
}

// Worktrees directory for non-devcontainer branch isolation
/**
 * Resolve the worktrees directory, honoring OCDC_WORKTREES_DIR.
 *
 * @returns {string} Absolute path to the worktrees directory
 */
export function getWorktreesDir() {
  return process.env.OCDC_WORKTREES_DIR ||
    join(process.env.HOME, ".local/share/opencode/worktree")
}

// Commands that should always run on host, not in container
export const HOST_COMMANDS = [
  // File navigation
  'cd', 'ls', 'pwd', 'find', 'tree',
  // File reading (opencode uses these)
  'cat', 'head', 'tail', 'less', 'more', 'wc',
  // File editing/searching (opencode uses these)
  'sed', 'awk', 'grep', 'rg', 'ed',
  // Git (always on host - repo is mounted)
  'git', 'gh',
  // Editors/IDEs
  'code', 'vim', 'nvim', 'nano', 'open', 'cursor',
  // System inspection
  'which', 'type', 'echo', 'env', 'printenv', 'whoami', 'hostname',
  // devcontainer/opencode commands (prevent recursion)
  'devcontainer', 'opencode',
  // direnv for environment setup
  'direnv',
  // Package managers (global installs on host)
  'brew', 'apt', 'apt-get', 'yum', 'dnf',
  // Docker (runs on host, not inside container)
  'docker', 'docker-compose',
]

// ============ Session Management ============

// In-memory cache to avoid repeated file reads on every bash command
const sessionCache = new Map()
// In-process save counter; attached to cached session objects only (never
// persisted) so saveSessionIfCurrent can detect a save that landed in the
// same millisecond as the baseline it was given
let sessionSaveSeq = 0

/**
 * Build the on-disk path for a session's state file.
 *
 * @param {string} sessionID - Session identifier
 * @returns {string} Absolute path to the session JSON file
 */
function getSessionFile(sessionID) {
  return join(getSessionsDir(), `${sessionID}.json`)
}

/**
 * Load a session's state, preferring the in-process cache over disk.
 *
 * @param {string} sessionID - Session identifier
 * @returns {object|null} Session state, or null when absent/corrupt
 */
export function loadSession(sessionID) {
  // Check cache first
  if (sessionCache.has(sessionID)) {
    return sessionCache.get(sessionID)
  }
  
  const file = getSessionFile(sessionID)
  if (!existsSync(file)) return null
  try {
    const session = JSON.parse(readFileSync(file, "utf-8"))
    sessionCache.set(sessionID, session)
    return session
  } catch {
    return null
  }
}

/**
 * Persist a session's state and refresh the in-process cache. The
 * cache-only change marker is stripped before writing so it never
 * reaches disk.
 *
 * @param {string} sessionID - Session identifier
 * @param {object} state - Session state to persist (activatedAt is set)
 */
export function saveSession(sessionID, state) {
  const sessionsDir = getSessionsDir()
  mkdirSync(sessionsDir, { recursive: true })
  // Strip the cache-only change marker: callers pass cached objects back in
  // (e.g. { ...session, starting: false }), which would otherwise persist it
  const clean = { ...state }
  delete clean._seq
  const session = {
    ...clean,
    activatedAt: new Date().toISOString()
  }
  writeFileSync(getSessionFile(sessionID), JSON.stringify(session, null, 2))
  // Update cache with the change marker (cache-only; the file stays clean)
  sessionCache.set(sessionID, { ...session, _seq: ++sessionSaveSeq })
}

/**
 * Delete a session's state file and drop it from the cache.
 *
 * @param {string} sessionID - Session identifier
 */
export function deleteSession(sessionID) {
  const file = getSessionFile(sessionID)
  if (existsSync(file)) {
    unlinkSync(file)
  }
  // Clear from cache
  sessionCache.delete(sessionID)
}

/**
 * Drop cached session state for every session targeting a workspace.
 * Core cleanup (remove()) deletes session files only; this clears the
 * in-process cache so removed workspaces stop routing commands.
 *
 * @param {string} workspace - Workspace path
 */
export function invalidateSessionCache(workspace) {
  for (const [sessionID, session] of sessionCache) {
    if (session?.workspace === workspace) {
      sessionCache.delete(sessionID)
    }
  }
}

/**
 * Save session state only if the session is unchanged since `baseline`
 * was taken (compared by the cache-only _seq change marker, so saves in
 * the same millisecond are still detected). Guards against a slow async
 * result overwriting a newer target, or recreating state after `off`
 * deleted it.
 *
 * @param {string} sessionID - Session ID
 * @param {object|null} baseline - Session state captured before the await
 * @param {object} state - New state to save
 * @returns {boolean} true if saved, false if the session changed meanwhile
 */
export function saveSessionIfCurrent(sessionID, baseline, state) {
  const current = loadSession(sessionID)
  const baselineSeq = baseline?._seq ?? null
  const currentSeq = current?._seq ?? null
  if (baselineSeq !== currentSeq) return false
  saveSession(sessionID, state)
  return true
}

// ============ Workspace Resolution ============

/**
 * Reject targets containing '.' or '..' path segments. Such a target can
 * stay inside the clones/worktrees directory after normalization (so a
 * containment check passes) while the unnormalized repo/branch pair handed
 * to removeClone() deletes a *different* repo's directory entirely.
 *
 * @param {string} target - Raw repo/branch target
 * @returns {boolean}
 */
function hasTraversalSegments(target) {
  return target.split('/').some((seg) => seg === '.' || seg === '..')
}

/**
 * Split a user-supplied target into `repoName` (when `repo/branch` syntax is
 * used) and `branch`.
 *
 * @param {string} branchArg - Branch name or `repo/branch` target
 * @returns {{repoName: string|null, branch: string}}
 */
function parseTarget(branchArg) {
  if (!branchArg.includes("/")) return { repoName: null, branch: branchArg }
  const parts = branchArg.split("/")
  return { repoName: parts[0], branch: parts.slice(1).join("/") }
}

/**
 * Resolve the git toplevel of the current directory, or null when not
 * inside a git repository.
 *
 * @returns {string|null}
 */
function inferRepoFromCwd() {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim()
  } catch {
    return null
  }
}

/**
 * Collect decorated matches for `branch` across every repository directory.
 *
 * @param {string} baseDir - Clones or worktrees directory
 * @param {string} branch - Branch name
 * @param {Function} decorate - Builds the result object for a match
 * @returns {Array} All matching workspaces
 */
function findBranchMatches(baseDir, branch, decorate) {
  if (!existsSync(baseDir)) return []

  const matches = []
  for (const repo of readdirSync(baseDir)) {
    const repoPath = join(baseDir, repo)
    try {
      if (!statSync(repoPath).isDirectory()) continue
    } catch {
      continue
    }

    const workspace = join(repoPath, branch)
    // isInside rejects '..' segments that would escape the base directory
    if (isInside(baseDir, workspace) && existsSync(workspace)) {
      matches.push(decorate(workspace, repo, branch))
    }
  }
  return matches
}

/**
 * Shared resolver behind resolveWorkspace/resolveWorktreeWorkspace.
 *
 * @param {string} baseDir - Clones or worktrees directory
 * @param {string} branchArg - Branch name or `repo/branch` target
 * @param {Function} decorate - Builds the result for a workspace match;
 *   receives the git toplevel as 4th argument when the repo was inferred
 *   from the current directory
 * @returns {object|null} Decorated workspace, ambiguity marker, or null
 */
function resolveWorkspaceIn(baseDir, branchArg, decorate) {
  if (hasTraversalSegments(branchArg)) return null

  const { repoName, branch } = parseTarget(branchArg)

  // If repo specified, look directly
  if (repoName) {
    const workspace = join(baseDir, repoName, branch)
    // isInside rejects '..' segments that would escape the base directory
    return isInside(baseDir, workspace) && existsSync(workspace)
      ? decorate(workspace, repoName, branch)
      : null
  }

  // Try to infer repo from current directory
  const gitRoot = inferRepoFromCwd()
  if (gitRoot) {
    const inferredRepo = basename(gitRoot)
    const workspace = join(baseDir, inferredRepo, branch)
    if (isInside(baseDir, workspace) && existsSync(workspace)) {
      return decorate(workspace, inferredRepo, branch, gitRoot)
    }
  }

  // Search all repos for this branch
  const matches = findBranchMatches(baseDir, branch, decorate)
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    return { ambiguous: true, matches }
  }

  return null
}

/**
 * Resolve a user-supplied target (`branch`, `repo/branch`) to an existing
 * devcontainer workspace. Rejects targets with '.'/'..' segments and
 * normalizes every join so a target can never escape the clones directory.
 *
 * @param {string} branchArg - Branch name or `repo/branch` target
 * @returns {{workspace: string, repoName: string, branch: string, ambiguous?: boolean, matches?: object[]}|null}
 *   Resolved workspace, or null when not found
 */
export function resolveWorkspace(branchArg) {
  return resolveWorkspaceIn(
    getClonesDir(),
    branchArg,
    (workspace, repoName, branch) => ({ workspace, repoName, branch })
  )
}

/**
 * Resolve a worktree workspace from branch argument
 * Similar to resolveWorkspace but for worktrees directory
 */
export function resolveWorktreeWorkspace(branchArg) {
  return resolveWorkspaceIn(
    getWorktreesDir(),
    branchArg,
    (workspace, repoName, branch, inferredMainRepo) => ({
      workspace,
      repoName,
      branch,
      // The inferred-repo path already knows the main repo; otherwise read
      // it from the worktree's .git file
      mainRepo: inferredMainRepo ?? getMainRepoFromWorktree(workspace),
      repo: repoName,
    })
  )
}

/**
 * Extract main repo path from a worktree's .git file
 */
function getMainRepoFromWorktree(worktreePath) {
  try {
    const gitFile = join(worktreePath, '.git')
    if (!existsSync(gitFile)) return null
    
    const content = readFileSync(gitFile, 'utf-8')
    if (!content.startsWith('gitdir:')) return null
    
    // Parse: gitdir: /path/to/main/.git/worktrees/<name>
    const gitdir = content.slice(7).trim()
    // Go up from .git/worktrees/<name> to get main repo
    // e.g., /path/to/main/.git/worktrees/feature -> /path/to/main
    const parts = gitdir.split('/')
    const worktreesIdx = parts.indexOf('worktrees')
    if (worktreesIdx > 0 && parts[worktreesIdx - 1] === '.git') {
      return parts.slice(0, worktreesIdx - 1).join('/')
    }
    return null
  } catch {
    return null
  }
}

// ============ Command Classification ============

/**
 * Classify whether a command must run on the host rather than in the
 * container, based on the leading command word.
 *
 * @param {string} command - Command text to classify
 * @returns {boolean|"escape"} True for host-bound commands, "escape" for
 *   the HOST: prefix, false to run inside the container
 */
export function shouldRunOnHost(command) {
  if (!command?.trim()) return true
  
  const trimmed = command.trim()
  
  // Check for HOST: escape hatch (case-insensitive)
  if (trimmed.toUpperCase().startsWith("HOST:")) {
    return "escape"
  }
  
  const firstWord = trimmed.split(/\s+/)[0]
  return HOST_COMMANDS.includes(firstWord)
}

// ============ Secure Command Execution ============

/**
 * Shell-quotes a string for safe inclusion in a shell command.
 * Uses single quotes which prevent all shell interpretation except for
 * single quotes themselves, which are escaped using the '"'"' pattern.
 * 
 * Returns the original string if it contains only safe characters.
 */
export function shellQuote(str) {
  // Safe characters that don't need quoting
  if (/^[a-zA-Z0-9_\-./=:@]+$/.test(str)) {
    return str
  }
  // Escape single quotes: close quote, add double-quoted single quote, reopen quote
  // "it's" becomes 'it'"'"'s'
  return "'" + str.replaceAll("'", "'\"'\"'") + "'"
}
