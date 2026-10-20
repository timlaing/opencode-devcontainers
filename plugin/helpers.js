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
export function getCacheDir() {
  return process.env.OCDC_CACHE_DIR || 
    join(process.env.HOME, ".cache/opencode-devcontainers")
}

export function getSessionsDir() {
  return process.env.OCDC_SESSIONS_DIR || 
    join(getCacheDir(), "opencode-sessions")
}

// Clones live alongside opencode desktop worktrees for discoverability
export function getClonesDir() {
  return process.env.OCDC_CLONES_DIR ||
    join(process.env.HOME, ".local/share/opencode/clone")
}

// Worktrees directory for non-devcontainer branch isolation
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

function getSessionFile(sessionID) {
  return join(getSessionsDir(), `${sessionID}.json`)
}

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

export function resolveWorkspace(branchArg) {
  if (hasTraversalSegments(branchArg)) return null

  const clonesDir = getClonesDir()
  let repoName = null
  let branch = branchArg
  
  // Handle repo/branch syntax
  if (branchArg.includes("/")) {
    const parts = branchArg.split("/")
    repoName = parts[0]
    branch = parts.slice(1).join("/")
  }
  
  // If repo specified, look directly
  if (repoName) {
    const clonePath = join(clonesDir, repoName, branch)
    // isInside rejects '..' segments that would escape the clones directory
    if (isInside(clonesDir, clonePath) && existsSync(clonePath)) {
      return { workspace: clonePath, repoName, branch }
    }
    return null
  }
  
  // Try to infer repo from current directory
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", { 
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim()
    repoName = basename(gitRoot)
    const clonePath = join(clonesDir, repoName, branch)
    if (isInside(clonesDir, clonePath) && existsSync(clonePath)) {
      return { workspace: clonePath, repoName, branch }
    }
  } catch {}
  
  // Search all repos for this branch
  if (existsSync(clonesDir)) {
    const matches = []
    for (const repo of readdirSync(clonesDir)) {
      const repoPath = join(clonesDir, repo)
      try {
        const stat = statSync(repoPath)
        if (!stat.isDirectory()) continue
      } catch { continue }
      
      const clonePath = join(repoPath, branch)
      if (isInside(clonesDir, clonePath) && existsSync(clonePath)) {
        matches.push({ workspace: clonePath, repoName: repo, branch })
      }
    }
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      return { ambiguous: true, matches }
    }
  }
  
  return null
}

/**
 * Resolve a worktree workspace from branch argument
 * Similar to resolveWorkspace but for worktrees directory
 */
export function resolveWorktreeWorkspace(branchArg) {
  if (hasTraversalSegments(branchArg)) return null

  const worktreesDir = getWorktreesDir()
  let repoName = null
  let branch = branchArg
  
  // Handle repo/branch syntax
  if (branchArg.includes("/")) {
    const parts = branchArg.split("/")
    repoName = parts[0]
    branch = parts.slice(1).join("/")
  }
  
  // If repo specified, look directly
  if (repoName) {
    const worktreePath = join(worktreesDir, repoName, branch)
    // isInside rejects '..' segments that would escape the worktrees directory
    if (isInside(worktreesDir, worktreePath) && existsSync(worktreePath)) {
      // Read .git file to get main repo path
      const mainRepo = getMainRepoFromWorktree(worktreePath)
      return { workspace: worktreePath, repoName, branch, mainRepo, repo: repoName }
    }
    return null
  }
  
  // Try to infer repo from current directory
  try {
    const gitRoot = execSync("git rev-parse --show-toplevel", { 
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    }).trim()
    repoName = basename(gitRoot)
    const worktreePath = join(worktreesDir, repoName, branch)
    if (isInside(worktreesDir, worktreePath) && existsSync(worktreePath)) {
      return { workspace: worktreePath, repoName, branch, mainRepo: gitRoot, repo: repoName }
    }
  } catch {}
  
  // Search all repos for this branch
  if (existsSync(worktreesDir)) {
    const matches = []
    for (const repo of readdirSync(worktreesDir)) {
      const repoPath = join(worktreesDir, repo)
      try {
        const stat = statSync(repoPath)
        if (!stat.isDirectory()) continue
      } catch { continue }
      
      const worktreePath = join(repoPath, branch)
      if (isInside(worktreesDir, worktreePath) && existsSync(worktreePath)) {
        const mainRepo = getMainRepoFromWorktree(worktreePath)
        matches.push({ workspace: worktreePath, repoName: repo, branch, mainRepo, repo })
      }
    }
    if (matches.length === 1) return matches[0]
    if (matches.length > 1) {
      return { ambiguous: true, matches }
    }
  }
  
  return null
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

export function shouldRunOnHost(command) {
  if (!command || !command.trim()) return true
  
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
  return "'" + str.replace(/'/g, "'\"'\"'") + "'"
}
