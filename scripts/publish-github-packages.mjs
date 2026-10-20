#!/usr/bin/env node
/**
 * Mirror the freshly released package to the GitHub Packages npm registry.
 *
 * semantic-release publishes the canonical version to npmjs (the default
 * registry) from `.releaserc.cjs`, with provenance. That publish is the
 * source of truth: it carries the version, the git tag, and the GitHub
 * Release. This script runs as a separate step afterward and pushes the
 * *same* version to GitHub Packages, so consumers who resolve the `@timlaing`
 * scope through `npm.pkg.github.com` get an identical artifact.
 *
 * Because semantic-release's `prepare` step has already written the release
 * version into the checked-out package.json, a plain `npm publish` here packs
 * the identical contents — no separate packing logic needed.
 *
 * Retry safety: if a mirror publish fails after npmjs already carries the
 * version, a re-run of the job checks out with no stamp (semantic-release
 * will not re-release an existing tag). In that case this script falls back
 * to the latest release tag: when that version is on npmjs but missing from
 * GitHub Packages, it publishes from a detached `git worktree` of the tag,
 * so the retried artifact still matches the released commit exactly.
 *
 * Auth follows the same mechanism as `@semantic-release/npm`: a temporary
 * `.npmrc` with a `//npm.pkg.github.com/:_authToken` line resolved from
 * `NODE_AUTH_TOKEN` (set to `GITHUB_TOKEN` in CI, which carries the
 * `packages: write` permission). Passing `--userconfig` keeps the `@timlaing`
 * scope mapping in the repo `.npmrc` from hijacking the explicit
 * `--registry`.
 *
 * npm allows only one provenance source per version, so this publish omits
 * `--provenance` to stay symmetric with the token-auth npmjs publish.
 *
 * Safety: dry run by default; `--publish` publishes for real. A real publish
 * that finds the version already present fails loudly rather than silently
 * skipping.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The npmrc auth key must be the full nerf-dart of the registry URL — leading
// slashes, trailing slash AND the colon before the setting name, yielding
// `//npm.pkg.github.com/:_authToken`. Dropping the slash or the colon makes
// npm fail to match the token to the registry and the publish 401s.
const GH_HOST = '//npm.pkg.github.com/'
const GH_PACKAGES_REGISTRY = 'https://npm.pkg.github.com'
const NPMJS_REGISTRY = 'https://registry.npmjs.org'
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * @returns {{ name: string, version: string }} package identity; in CI the
 *   version is the release version semantic-release wrote during `prepare`.
 */
function readPkg() {
  const { name, version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  return { name, version }
}

/**
 * @param {string} name package name
 * @param {string} version version to probe
 * @param {string} userconfig path to an .npmrc that references ${NODE_AUTH_TOKEN}
 * @param {string} token GitHub token to expose as NODE_AUTH_TOKEN for the probe
 * @returns {boolean} true when `version` is already on GitHub Packages
 */
function alreadyPublished(name, version, userconfig, token) {
  // GitHub Packages requires a token even to read public packages, so this
  // probe is authenticated — an unauthenticated probe would always error and
  // silently read as "not published", making the guard inert. The token is
  // the one resolved by main() (GITHUB_TOKEN ?? GH_TOKEN ?? NODE_AUTH_TOKEN)
  // so every documented fallback also authenticates the probe, not just
  // NODE_AUTH_TOKEN being set in the environment.
  try {
    execFileSync(
      'npm',
      ['view', `${name}@${version}`, 'version', '--registry', GH_PACKAGES_REGISTRY, '--userconfig', userconfig],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_AUTH_TOKEN: token } }
    )
    return true
  } catch (error) {
    const detail = String(error.stderr ?? error.message ?? error)
    // Auth failures mean the probe could not answer — surface them rather
    // than pretending the version is absent.
    if (/E401|ENEEDAUTH|401|unauthorized/i.test(detail)) {
      throw new Error(`authenticated probe failed for ${name}@${version}: ${detail}`)
    }
    // E404 means the version is genuinely absent.
    if (/E404|404|not found/i.test(detail)) {
      return false
    }
    throw error
  }
}

/**
 * @returns {string | undefined} most recent release tag (for example
 *   `v1.0.0`), or undefined when the repository has no release tags yet or
 *   the newest tag does not match semantic-release's `v<semver>` tag format.
 */
function latestReleaseTag() {
  const out = execFileSync('git', ['tag', '--list', 'v*', '--sort=-version:refname'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const versionTag = out
    .split('\n')
    .map((tag) => tag.trim())
    .find((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
  return versionTag
}

/**
 * @param {string} name package name
 * @param {string} version version to check
 * @returns {boolean} true when the version exists on npmjs — the canonical
 *   registry; its public reads need no auth, and a network failure reads as
 *   "not published" so the caller refuses to mirror (the safe direction).
 */
function onNpmjs(name, version) {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version', '--registry', NPMJS_REGISTRY], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    return true
  } catch {
    return false
  }
}

function main() {
  const { name, version } = readPkg()
  const dryRun = !process.argv.includes('--publish')
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.NODE_AUTH_TOKEN

  // semantic-release's `prepare` only stamps the released version into the
  // working package.json when a release actually happens. If the working
  // version still matches the committed one, this run published nothing.
  // Exit codes cannot tell the two apart: semantic-release's CLI exits 0
  // both when it released and when there was nothing to release (index.js
  // returns false without throwing; only errors reach cli.js's catch and
  // exit 1), so the stamped-vs-committed comparison is the reliable signal.
  const committed = JSON.parse(
    execFileSync('git', ['show', 'HEAD:package.json'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  )

  // A real publish needs a token; an empty/absent one would otherwise fail
  // deep inside npm with an opaque auth error.
  if (!dryRun && !token) {
    throw new Error(
      'no GitHub token in environment (set GITHUB_TOKEN, GH_TOKEN or NODE_AUTH_TOKEN with packages:write)'
    )
  }

  // Isolated userconfig so the repo's scope mapping cannot interfere and the
  // token never touches the working tree.
  const dir = mkdtempSync(join(tmpdir(), 'ocdc-ghpkg-'))
  const userconfig = join(dir, '.npmrc')
  // publishCwd is where `npm publish` packs from: the CI checkout on the
  // stamped path, a detached worktree of the release tag on the retry path.
  let publishCwd = repoRoot
  let target = version
  try {
    // Full nerf-dart key: `//npm.pkg.github.com/:_authToken` — the colon
    // before the setting name is required as much as the trailing slash.
    writeFileSync(userconfig, `${GH_HOST}:_authToken = \${NODE_AUTH_TOKEN}\n`)

    if (committed.version !== version) {
      // Stamped path: this run just released `version` from this checkout.
      // Without a token the duplicate check cannot run (GitHub Packages
      // refuses anonymous reads); that only happens in a dry run, which
      // publishes nothing, so skipping the guard is safe. `--publish` runs
      // already threw above when no token was resolved.
      if (token && alreadyPublished(name, version, userconfig, token)) {
        throw new Error(`${name}@${version} already exists on ${GH_PACKAGES_REGISTRY}; refusing to overwrite`)
      } else if (!token) {
        console.log('[publish-github-packages] dry run without a token: skipping duplicate-version check')
      }
    } else {
      // No stamp: this run released nothing. Normally that means there is
      // nothing to mirror — but it is also what a re-run looks like after a
      // mirror publish failed following a successful npmjs publish (the tag
      // was already pushed, so semantic-release does not re-release it).
      // Recover that case by mirroring the latest release tag when GitHub
      // Packages lacks it. A tokenless dry run just reports and stops.
      const tag = latestReleaseTag()
      if (!tag) {
        console.log('[publish-github-packages] no stamped version and no release tags; nothing to mirror')
        return
      }
      const taggedVersion = tag.slice(1)
      if (!token) {
        console.log(`[publish-github-packages] dry run without a token: skipping mirror-retry check for ${taggedVersion}`)
        return
      }
      if (alreadyPublished(name, taggedVersion, userconfig, token)) {
        console.log(`[publish-github-packages] ${taggedVersion} already on ${GH_PACKAGES_REGISTRY}; nothing to mirror`)
        return
      }
      // npmjs is the source of truth: never mirror a version that was not
      // canonically published (this also refuses a tag whose npmjs publish
      // failed, and any tag pushed by hand).
      if (!onNpmjs(name, taggedVersion)) {
        console.log(`[publish-github-packages] ${taggedVersion} is not on npmjs (the canonical registry); refusing to mirror it`)
        return
      }
      console.log(`[publish-github-packages] ${taggedVersion} missing from ${GH_PACKAGES_REGISTRY}; retrying mirror from tag ${tag}`)
      const worktree = join(dir, 'worktree')
      execFileSync('git', ['worktree', 'add', '--detach', worktree, tag], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      // The tag commits the placeholder version (releases never commit the
      // stamped version); stamp the tag tree exactly like semantic-release's
      // prepare did for the canonical publish so the retried artifact is
      // byte-identical in identity, not a stray placeholder version.
      const pkgPath = join(worktree, 'package.json')
      const worktreePkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      worktreePkg.version = taggedVersion
      writeFileSync(pkgPath, `${JSON.stringify(worktreePkg, null, 2)}\n`)
      publishCwd = worktree
      target = taggedVersion
    }

    const args = [
      'publish',
      '--registry',
      GH_PACKAGES_REGISTRY,
      '--access',
      'public',
      '--userconfig',
      userconfig,
      ...(dryRun ? ['--dry-run'] : []),
    ]

    console.log(
      `[publish-github-packages] ${name}@${target} -> ${GH_PACKAGES_REGISTRY}${dryRun ? ' (dry run; pass --publish to publish)' : ''}`
    )

    execFileSync('npm', args, { cwd: publishCwd, stdio: 'inherit', env: { ...process.env, NODE_AUTH_TOKEN: token } })

    console.log(`[publish-github-packages] ${name}@${target} -> ${GH_PACKAGES_REGISTRY} ok`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    // Clear the tag worktree's git registration after its directory is gone
    // (best-effort: no registration to prune when the stamped path ran).
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'ignore' })
    } catch {
      // nothing to prune
    }
  }
}

try {
  main()
} catch (error) {
  console.error(`[publish-github-packages] failed: ${error.message}`)
  process.exit(1)
}
