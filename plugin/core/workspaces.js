/**
 * Unified workspace management for opencode-devcontainers
 * 
 * Provides a unified view of all workspaces (clones + worktrees) with
 * status information for cleanup and management.
 */

import { stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { listClones } from './clones.js'
import { listWorktreeWorkspaces } from './worktree.js'

/**
 * Run a git command and return the output
 * 
 * @param {string[]} args - Git command arguments
 * @param {string} cwd - Working directory
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
async function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', data => {
      stdout += data.toString()
    })

    child.stderr.on('data', data => {
      stderr += data.toString()
    })

    child.on('close', exitCode => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode })
    })

    child.on('error', reject)
  })
}

/**
 * List all workspaces (clones and worktrees)
 * 
 * @param {object} [options]
 * @param {string} [options.type] - Filter by type: 'clone' or 'worktree'
 * @returns {Promise<Array<{type: string, workspace: string, repo: string, branch: string}>>}
 */
export async function listAllWorkspaces(options = {}) {
  const { type: filterType } = options
  const results = []
  
  // List clones
  if (!filterType || filterType === 'clone') {
    const clones = await listClones()
    for (const clone of clones) {
      results.push({
        type: 'clone',
        workspace: clone.workspace,
        repo: clone.repo,
        branch: clone.branch,
      })
    }
  }
  
  // List worktrees
  if (!filterType || filterType === 'worktree') {
    const worktrees = await listWorktreeWorkspaces()
    for (const wt of worktrees) {
      results.push({
        type: 'worktree',
        workspace: wt.workspace,
        repo: wt.repo,
        branch: wt.branch,
      })
    }
  }
  
  return results
}

/**
 * Get detailed status for a workspace
 * 
 * @param {string} workspace - Workspace path
 * @returns {Promise<{hasUncommitted: boolean, uncommittedCount: number, lastAccess: Date}>}
 */
export async function getWorkspaceStatus(workspace) {
  const result = {
    hasUncommitted: false,
    uncommittedCount: 0,
    lastAccess: new Date(),
  }
  
  // Get last access time from directory mtime
  try {
    const stats = await stat(workspace)
    result.lastAccess = stats.mtime
  } catch {
    // Directory doesn't exist or can't be accessed
  }
  
  // Check for uncommitted changes
  try {
    const gitStatus = await runGit(['status', '--porcelain'], workspace)
    if (gitStatus.exitCode === 0 && gitStatus.stdout) {
      const lines = gitStatus.stdout.split('\n').filter(Boolean)
      result.uncommittedCount = lines.length
      result.hasUncommitted = lines.length > 0
    }
  } catch {
    // Not a git repo or git error
  }
  
  return result
}

/**
 * Find stale workspaces (no activity in N days)
 * 
 * @param {object} [options]
 * @param {number} [options.maxAgeDays=7] - Maximum age in days before considered stale
 * @returns {Promise<Array<{type: string, workspace: string, repo: string, branch: string, lastAccess: Date, hasUncommitted: boolean}>>}
 */
export async function findStaleWorkspaces(options = {}) {
  const { maxAgeDays = 7 } = options
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000
  const cutoff = Date.now() - maxAgeMs
  
  const allWorkspaces = await listAllWorkspaces()
  const stale = []
  
  for (const ws of allWorkspaces) {
    const status = await getWorkspaceStatus(ws.workspace)
    
    if (status.lastAccess.getTime() < cutoff) {
      stale.push({
        ...ws,
        lastAccess: status.lastAccess,
        hasUncommitted: status.hasUncommitted,
        uncommittedCount: status.uncommittedCount,
      })
    }
  }
  
  return stale
}

/**
 * Format workspace info for display
 * 
 * @param {object} workspace - Workspace object
 * @param {object} [status] - Status object from getWorkspaceStatus
 * @returns {string} Formatted string
 */
export function formatWorkspace(workspace, status) {
  let str = `${workspace.type === 'clone' ? '[clone]' : '[worktree]'} ${workspace.repo}/${workspace.branch}`
  
  if (status) {
    const age = Math.floor((Date.now() - status.lastAccess.getTime()) / (24 * 60 * 60 * 1000))
    str += ` (${age}d ago)`
    if (status.hasUncommitted) {
      str += ` [${status.uncommittedCount} uncommitted]`
    }
  }
  
  return str
}

export default {
  listAllWorkspaces,
  getWorkspaceStatus,
  findStaleWorkspaces,
  formatWorkspace,
}
