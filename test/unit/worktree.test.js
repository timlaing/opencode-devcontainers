/**
 * Tests for plugin/core/worktree.js
 * 
 * Run with: node --test test/unit/worktree.test.js
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// Module under test
import { 
  getWorktreePath,
  createWorktreeWorkspace,
  listWorktreeWorkspaces,
  removeWorktreeWorkspace,
} from '../../plugin/core/worktree.js'
import { PATHS } from '../../plugin/core/paths.js'

describe('getWorktreePath', () => {
  test('returns path under worktrees directory', () => {
    const path = getWorktreePath('my-repo', 'feature-branch')
    assert.strictEqual(path, join(PATHS.worktrees, 'my-repo', 'feature-branch'))
  })

  test('handles branches with slashes', () => {
    const path = getWorktreePath('my-repo', 'feature/nested/branch')
    assert.strictEqual(path, join(PATHS.worktrees, 'my-repo', 'feature/nested/branch'))
  })
})

describe('createWorktreeWorkspace', () => {
  const testDir = join(homedir(), '.cache/ocw-test-createwt-' + Date.now())
  const mainRepo = join(testDir, 'main')

  beforeEach(() => {
    process.env.OCDC_WORKTREES_DIR = join(testDir, 'worktrees')
    
    mkdirSync(mainRepo, { recursive: true })
    
    // Create main repo with initial commit
    execSync('git init -b main', { cwd: mainRepo })
    writeFileSync(join(mainRepo, '.gitignore'), '.env\nsecrets.json\n')
    writeFileSync(join(mainRepo, 'README.md'), '# Test')
    execSync('git add .', { cwd: mainRepo })
    execSync('git commit -m "Initial commit"', { cwd: mainRepo })
    
    // Add gitignored files (secrets to be copied)
    writeFileSync(join(mainRepo, '.env'), 'SECRET=value')
    writeFileSync(join(mainRepo, 'secrets.json'), '{"key":"secret"}')
  })

  afterEach(() => {
    delete process.env.OCDC_WORKTREES_DIR
    rmSync(testDir, { recursive: true, force: true })
  })

  test('creates worktree in correct location', async () => {
    const result = await createWorktreeWorkspace({
      repoRoot: mainRepo,
      branch: 'feature-x',
    })
    
    assert.ok(result.workspace.includes('worktrees'))
    assert.ok(result.workspace.includes('main'))
    assert.ok(result.workspace.includes('feature-x'))
    assert.strictEqual(result.repoName, 'main')
    assert.strictEqual(result.branch, 'feature-x')
    assert.strictEqual(result.mainRepo, mainRepo)
    assert.ok(existsSync(result.workspace))
  })

  test('copies gitignored files to worktree', async () => {
    const result = await createWorktreeWorkspace({
      repoRoot: mainRepo,
      branch: 'feature-secrets',
    })
    
    assert.ok(existsSync(join(result.workspace, '.env')))
    assert.ok(existsSync(join(result.workspace, 'secrets.json')))
    
    const envContent = readFileSync(join(result.workspace, '.env'), 'utf-8')
    assert.strictEqual(envContent, 'SECRET=value')
  })

  test('throws error when already in a worktree', async () => {
    // Create a worktree first
    const result = await createWorktreeWorkspace({
      repoRoot: mainRepo,
      branch: 'first-wt',
    })
    
    // Try to create another worktree from within the first one
    await assert.rejects(
      () => createWorktreeWorkspace({
        repoRoot: result.workspace,
        branch: 'nested-wt',
      }),
      /already in a worktree/i
    )
  })

  test('throws error when not in a git repo', async () => {
    const nonGitDir = join(testDir, 'nongit')
    mkdirSync(nonGitDir, { recursive: true })
    
    await assert.rejects(
      () => createWorktreeWorkspace({
        repoRoot: nonGitDir,
        branch: 'feature',
      }),
      /not a git repository/i
    )
  })

  test('returns existing worktree without recreating', async () => {
    const result1 = await createWorktreeWorkspace({
      repoRoot: mainRepo,
      branch: 'existing-branch',
    })
    
    // Modify worktree to verify it's not recreated
    writeFileSync(join(result1.workspace, 'marker.txt'), 'exists')
    
    const result2 = await createWorktreeWorkspace({
      repoRoot: mainRepo,
      branch: 'existing-branch',
    })
    
    assert.strictEqual(result1.workspace, result2.workspace)
    assert.ok(existsSync(join(result2.workspace, 'marker.txt')))
  })
})

describe('listWorktreeWorkspaces', () => {
  const testDir = join(homedir(), '.cache/ocw-test-listwt-' + Date.now())

  beforeEach(() => {
    process.env.OCDC_WORKTREES_DIR = testDir
    
    // Create some worktree directories with .git files (simulating worktrees)
    mkdirSync(join(testDir, 'repo-a', 'main'), { recursive: true })
    mkdirSync(join(testDir, 'repo-a', 'feature'), { recursive: true })
    mkdirSync(join(testDir, 'repo-b', 'develop'), { recursive: true })
    
    // Add .git files to simulate real worktrees
    writeFileSync(join(testDir, 'repo-a', 'main', '.git'), 'gitdir: /path/to/main/.git/worktrees/main')
    writeFileSync(join(testDir, 'repo-a', 'feature', '.git'), 'gitdir: /path/to/main/.git/worktrees/feature')
    writeFileSync(join(testDir, 'repo-b', 'develop', '.git'), 'gitdir: /path/to/main/.git/worktrees/develop')
  })

  afterEach(() => {
    delete process.env.OCDC_WORKTREES_DIR
    rmSync(testDir, { recursive: true, force: true })
  })

  test('lists all worktree workspaces', async () => {
    const worktrees = await listWorktreeWorkspaces()
    
    assert.strictEqual(worktrees.length, 3)
    assert.ok(worktrees.some(wt => wt.repo === 'repo-a' && wt.branch === 'main'))
    assert.ok(worktrees.some(wt => wt.repo === 'repo-a' && wt.branch === 'feature'))
    assert.ok(worktrees.some(wt => wt.repo === 'repo-b' && wt.branch === 'develop'))
  })

  test('filters by repo', async () => {
    const worktrees = await listWorktreeWorkspaces({ repo: 'repo-a' })
    
    assert.strictEqual(worktrees.length, 2)
    assert.ok(worktrees.every(wt => wt.repo === 'repo-a'))
  })

  test('returns empty array when no worktrees', async () => {
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })
    
    const worktrees = await listWorktreeWorkspaces()
    assert.deepStrictEqual(worktrees, [])
  })
})

describe('removeWorktreeWorkspace', () => {
  const testDir = join(homedir(), '.cache/ocw-test-removewt-' + Date.now())
  const mainRepo = join(testDir, 'main')

  beforeEach(() => {
    process.env.OCDC_WORKTREES_DIR = join(testDir, 'worktrees')
    
    mkdirSync(mainRepo, { recursive: true })
    
    execSync('git init -b main', { cwd: mainRepo })
    writeFileSync(join(mainRepo, 'README.md'), '# Test')
    execSync('git add .', { cwd: mainRepo })
    execSync('git commit -m "Initial commit"', { cwd: mainRepo })
  })

  afterEach(() => {
    delete process.env.OCDC_WORKTREES_DIR
    rmSync(testDir, { recursive: true, force: true })
  })

  test('removes worktree workspace successfully', async () => {
    const result = await createWorktreeWorkspace({
      repoRoot: mainRepo,
      branch: 'to-remove',
    })
    
    assert.ok(existsSync(result.workspace))
    
    await removeWorktreeWorkspace(result.workspace, mainRepo)
    
    assert.ok(!existsSync(result.workspace))
  })

  test('removes worktree with force option when dirty', async () => {
    const result = await createWorktreeWorkspace({
      repoRoot: mainRepo,
      branch: 'dirty-branch',
    })
    
    // Make it dirty
    writeFileSync(join(result.workspace, 'uncommitted.txt'), 'dirty')
    
    await removeWorktreeWorkspace(result.workspace, mainRepo, { force: true })
    
    assert.ok(!existsSync(result.workspace))
  })

  test('returns false for non-existent workspace', async () => {
    const removed = await removeWorktreeWorkspace('/nonexistent/path', mainRepo)
    assert.strictEqual(removed, false)
  })
})
