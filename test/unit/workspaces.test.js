/**
 * Tests for plugin/core/workspaces.js
 * 
 * Run with: node --test test/unit/workspaces.test.js
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'

// Module under test
import { 
  listAllWorkspaces,
  getWorkspaceStatus,
  findStaleWorkspaces,
} from '../../plugin/core/workspaces.js'

describe('listAllWorkspaces', () => {
  const testDir = join(homedir(), '.cache/ocw-test-listall-' + Date.now())

  beforeEach(() => {
    process.env.OCDC_CLONES_DIR = join(testDir, 'clones')
    process.env.OCDC_WORKTREES_DIR = join(testDir, 'worktrees')
    
    // Create some clone directories
    mkdirSync(join(testDir, 'clones', 'repo-a', 'main'), { recursive: true })
    mkdirSync(join(testDir, 'clones', 'repo-a', 'feature'), { recursive: true })
    
    // Add .git directories to simulate real clones
    mkdirSync(join(testDir, 'clones', 'repo-a', 'main', '.git'), { recursive: true })
    mkdirSync(join(testDir, 'clones', 'repo-a', 'feature', '.git'), { recursive: true })
    
    // Create some worktree directories
    mkdirSync(join(testDir, 'worktrees', 'repo-b', 'develop'), { recursive: true })
    
    // Add .git file to simulate real worktree
    writeFileSync(
      join(testDir, 'worktrees', 'repo-b', 'develop', '.git'),
      'gitdir: /path/to/main/.git/worktrees/develop'
    )
  })

  afterEach(() => {
    delete process.env.OCDC_CLONES_DIR
    delete process.env.OCDC_WORKTREES_DIR
    rmSync(testDir, { recursive: true, force: true })
  })

  test('lists both clones and worktrees', async () => {
    const workspaces = await listAllWorkspaces()
    
    assert.strictEqual(workspaces.length, 3)
    
    // Check clones are included with type 'clone'
    const clones = workspaces.filter(w => w.type === 'clone')
    assert.strictEqual(clones.length, 2)
    assert.ok(clones.some(c => c.repo === 'repo-a' && c.branch === 'main'))
    assert.ok(clones.some(c => c.repo === 'repo-a' && c.branch === 'feature'))
    
    // Check worktrees are included with type 'worktree'
    const worktrees = workspaces.filter(w => w.type === 'worktree')
    assert.strictEqual(worktrees.length, 1)
    assert.ok(worktrees.some(w => w.repo === 'repo-b' && w.branch === 'develop'))
  })

  test('filters by type', async () => {
    const clones = await listAllWorkspaces({ type: 'clone' })
    assert.strictEqual(clones.length, 2)
    assert.ok(clones.every(w => w.type === 'clone'))
    
    const worktrees = await listAllWorkspaces({ type: 'worktree' })
    assert.strictEqual(worktrees.length, 1)
    assert.ok(worktrees.every(w => w.type === 'worktree'))
  })

  test('returns empty array when no workspaces', async () => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(join(testDir, 'clones'), { recursive: true })
    mkdirSync(join(testDir, 'worktrees'), { recursive: true })
    
    const workspaces = await listAllWorkspaces()
    assert.deepStrictEqual(workspaces, [])
  })
})

describe('getWorkspaceStatus', () => {
  const testDir = join(homedir(), '.cache/ocw-test-status-' + Date.now())
  const mainRepo = join(testDir, 'main')

  beforeEach(() => {
    mkdirSync(mainRepo, { recursive: true })
    
    // Create main repo with initial commit
    execSync('git init -b main', { cwd: mainRepo })
    writeFileSync(join(mainRepo, 'README.md'), '# Test')
    execSync('git add .', { cwd: mainRepo })
    execSync('git commit -m "Initial commit"', { cwd: mainRepo })
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  test('returns clean status for committed repo', async () => {
    const status = await getWorkspaceStatus(mainRepo)
    
    assert.strictEqual(status.hasUncommitted, false)
    assert.strictEqual(status.uncommittedCount, 0)
  })

  test('returns dirty status for uncommitted changes', async () => {
    writeFileSync(join(mainRepo, 'new-file.txt'), 'uncommitted')
    
    const status = await getWorkspaceStatus(mainRepo)
    
    assert.strictEqual(status.hasUncommitted, true)
    assert.ok(status.uncommittedCount > 0)
  })

  test('includes last access time', async () => {
    const status = await getWorkspaceStatus(mainRepo)
    
    assert.ok(status.lastAccess instanceof Date)
    // Should be recent (within last minute)
    assert.ok(Date.now() - status.lastAccess.getTime() < 60000)
  })

  test('handles non-git directories gracefully', async () => {
    const nonGitDir = join(testDir, 'nongit')
    mkdirSync(nonGitDir, { recursive: true })
    
    const status = await getWorkspaceStatus(nonGitDir)
    
    assert.strictEqual(status.hasUncommitted, false)
    assert.strictEqual(status.uncommittedCount, 0)
  })
})

describe('findStaleWorkspaces', () => {
  const testDir = join(homedir(), '.cache/ocw-test-stale-' + Date.now())

  beforeEach(() => {
    process.env.OCDC_CLONES_DIR = join(testDir, 'clones')
    process.env.OCDC_WORKTREES_DIR = join(testDir, 'worktrees')
    
    // Create a "fresh" clone (recent mtime)
    mkdirSync(join(testDir, 'clones', 'repo-a', 'fresh'), { recursive: true })
    mkdirSync(join(testDir, 'clones', 'repo-a', 'fresh', '.git'), { recursive: true })
    
    // Create a "stale" clone (old mtime) - we'll backdate it
    mkdirSync(join(testDir, 'clones', 'repo-a', 'stale'), { recursive: true })
    mkdirSync(join(testDir, 'clones', 'repo-a', 'stale', '.git'), { recursive: true })
  })

  afterEach(() => {
    delete process.env.OCDC_CLONES_DIR
    delete process.env.OCDC_WORKTREES_DIR
    rmSync(testDir, { recursive: true, force: true })
  })

  test('identifies stale workspaces by age', async () => {
    // Backdate the "stale" directory
    const staleDir = join(testDir, 'clones', 'repo-a', 'stale')
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) // 8 days ago
    const { utimes } = await import('node:fs/promises')
    await utimes(staleDir, oldTime, oldTime)
    
    const stale = await findStaleWorkspaces({ maxAgeDays: 7 })
    
    assert.strictEqual(stale.length, 1)
    assert.strictEqual(stale[0].branch, 'stale')
  })

  test('respects maxAgeDays parameter', async () => {
    // With a very long max age, nothing should be stale
    const stale = await findStaleWorkspaces({ maxAgeDays: 365 })
    assert.strictEqual(stale.length, 0)
  })

  test('returns empty array when no stale workspaces', async () => {
    const stale = await findStaleWorkspaces({ maxAgeDays: 7 })
    assert.strictEqual(stale.length, 0)
  })
})
