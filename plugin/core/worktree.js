/**
 * Worktree management for opencode-devcontainers
 * 
 * Creates isolated git worktrees for branch-based development without devcontainers.
 * Provides the same session management as devcontainer clones but with simpler
 * filesystem isolation.
 */

import { join, basename, dirname } from 'node:path'
import { mkdir, readdir, stat, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { PATHS, exists } from './paths.js'
import { 
  createWorktree as gitCreateWorktree, 
  removeWorktree as gitRemoveWorktree,
  isWorktree,
  isGitRepo,
} from './git.js'
import { copyGitignored } from './clones.js'

/**
 * Get the path where a worktree workspace would be created
 * 
 * @param {string} repo - Repository name
 * @param {string} branch - Branch name
 * @returns {string} Absolute path to worktree directory
 */
export function getWorktreePath(repo, branch) {
  return join(PATHS.worktrees, repo, branch)
}

/**
 * Create a worktree workspace for isolated branch development
 * 
 * Orchestrates:
 * 1. Validate: in git repo, not already in a worktree
 * 2. Create worktree
 * 3. Copy secrets (gitignored files)
 * 4. Run direnv allow (if .envrc exists)
 * 
 * @param {object} options
 * @param {string} options.repoRoot - Path to main repository
 * @param {string} options.branch - Branch name to create/checkout
 * @param {boolean} [options.force] - Force recreate if exists
 * @returns {Promise<{workspace: string, repoName: string, branch: string, mainRepo: string}>}
 */
export async function createWorktreeWorkspace(options) {
  const { repoRoot, branch, force = false } = options
  
  // Validate: in git repo
  if (!await isGitRepo(repoRoot)) {
    throw new Error('Not a git repository')
  }
  
  // Validate: not already in a worktree
  if (await isWorktree(repoRoot)) {
    throw new Error('Already in a worktree. Use the main repository to create new worktrees.')
  }
  
  const repoName = basename(repoRoot)
  const workspace = getWorktreePath(repoName, branch)
  
  // Check if worktree already exists
  if (await exists(workspace)) {
    if (!force) {
      return { workspace, repoName, branch, mainRepo: repoRoot }
    }
    // Force recreate - remove existing
    await gitRemoveWorktree(repoRoot, workspace, { force: true })
  }
  
  // Create parent directory
  await mkdir(dirname(workspace), { recursive: true })
  
  // Create worktree
  await gitCreateWorktree(repoRoot, branch, workspace)
  
  // Copy gitignored files (secrets, local config)
  await copyGitignored(repoRoot, workspace)
  
  // Run direnv allow if .envrc exists (fire-and-forget)
  if (existsSync(join(workspace, '.envrc'))) {
    runDirenvAllow(workspace)
  }
  
  return { workspace, repoName, branch, mainRepo: repoRoot }
}

/**
 * Run direnv allow in the background (fire-and-forget)
 * This is optional - if direnv isn't installed, we silently ignore.
 * 
 * @param {string} workspace - Workspace directory
 */
function runDirenvAllow(workspace) {
  const { spawn } = require('node:child_process')
  
  try {
    const child = spawn('direnv', ['allow'], {
      cwd: workspace,
      stdio: 'ignore',
      detached: true,
    })
    child.unref()
  } catch {
    // direnv not installed, ignore
  }
}

/**
 * Check whether a workspace directory is a git worktree: its .git entry
 * must be a file containing a gitdir reference.
 *
 * @param {string} workspace - Workspace path
 * @returns {Promise<boolean>}
 */
async function isWorktreeWorkspace(workspace) {
  const gitPath = join(workspace, '.git')
  try {
    const gitStat = await stat(gitPath)
    if (!gitStat.isFile()) return false
    // Verify it's a gitdir reference
    const content = await readFile(gitPath, 'utf-8')
    return content.startsWith('gitdir:')
  } catch {
    // Not a valid worktree
    return false
  }
}

/**
 * List all worktree workspaces
 * 
 * @param {object} [options]
 * @param {string} [options.repo] - Filter by repository name
 * @returns {Promise<Array<{workspace: string, repo: string, branch: string}>>}
 */
export async function listWorktreeWorkspaces(options = {}) {
  const { repo: filterRepo } = options
  const worktrees = []
  
  if (!existsSync(PATHS.worktrees)) {
    return worktrees
  }
  
  const repos = await readdir(PATHS.worktrees)
  
  // Process repos in parallel; each repo's branches are processed in parallel
  const repoResults = await Promise.all(
    repos.map(async (repo) => {
      if (filterRepo && repo !== filterRepo) return []
      
      const repoPath = join(PATHS.worktrees, repo)
      const repoStat = await stat(repoPath).catch(() => null)
      if (!repoStat?.isDirectory()) return []
      
      const branches = await readdir(repoPath)
      
      // Check branches in parallel; isWorktreeWorkspace is independent per branch
      const branchResults = await Promise.all(
        branches.map(async (branch) => {
          const workspace = join(repoPath, branch)
          const isWt = await isWorktreeWorkspace(workspace)
          return isWt ? { workspace, repo, branch } : null
        })
      )
      
      return branchResults.filter(Boolean)
    })
  )
  
  return repoResults.flat()
}

/**
 * Remove a worktree workspace
 * 
 * Must be called with the main repo path since git worktree remove
 * must be run from the main repo.
 * 
 * @param {string} workspace - Workspace path to remove
 * @param {string} mainRepo - Path to the main repository
 * @param {object} [options]
 * @param {boolean} [options.force] - Force removal even if dirty
 * @returns {Promise<boolean>} True if removed, false if didn't exist
 */
export async function removeWorktreeWorkspace(workspace, mainRepo, options = {}) {
  const { force = false } = options
  
  if (!existsSync(workspace)) {
    return false
  }
  
  await gitRemoveWorktree(mainRepo, workspace, { force })
  return true
}

export default {
  getWorktreePath,
  createWorktreeWorkspace,
  listWorktreeWorkspaces,
  removeWorktreeWorkspace,
}
