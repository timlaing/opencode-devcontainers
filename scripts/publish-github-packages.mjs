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

// The `_authToken` key must be the nerf-darted registry URL, which includes a
// trailing slash (`//npm.pkg.github.com/`). Without it npm will not match the
// token to the registry and the publish fails with a 401.
const GH_HOST = '//npm.pkg.github.com/'
const GH_PACKAGES_REGISTRY = 'https://npm.pkg.github.com'
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

function main() {
  const { name, version } = readPkg()
  const dryRun = !process.argv.includes('--publish')
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.NODE_AUTH_TOKEN

  // semantic-release's `prepare` only stamps the released version into the
  // working package.json when a release actually happens. If the working
  // version still matches the committed one, this push had no releasable
  // commits (docs-only, chore, etc.) — nothing to mirror. This is the check
  // the workflow's removed `if:` gate could not make, because semantic-release
  // exits 1 for both "no release needed" and "release failed".
  const committed = JSON.parse(
    execFileSync('git', ['show', 'HEAD:package.json'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  )
  if (committed.version === version) {
    console.log(`[publish-github-packages] no release on this push (package.json still at ${version}); nothing to mirror`)
    return
  }

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
  try {
    // `${GH_HOST}:_authToken` -> `//npm.pkg.github.com/:_authToken`: the
    // nerf-darted key keeps BOTH the leading slashes and the colon before
    // the setting name; dropping either makes npm fail to match the token
    // to the registry and the publish 401s.
    writeFileSync(userconfig, `${GH_HOST}:_authToken = \${NODE_AUTH_TOKEN}\n`)

    // Without a token the duplicate check cannot run (GitHub Packages
    // refuses anonymous reads); that only happens in a dry run, which
    // publishes nothing, so skipping the guard is safe. `--publish` runs
    // already threw above when no token was resolved.
    if (token && alreadyPublished(name, version, userconfig, token)) {
      throw new Error(`${name}@${version} already exists on ${GH_PACKAGES_REGISTRY}; refusing to overwrite`)
    } else if (!token) {
      console.log('[publish-github-packages] dry run without a token: skipping duplicate-version check')
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
      `[publish-github-packages] ${name}@${version} -> ${GH_PACKAGES_REGISTRY}${dryRun ? ' (dry run; pass --publish to publish)' : ''}`
    )

    execFileSync('npm', args, { cwd: repoRoot, stdio: 'inherit', env: { ...process.env, NODE_AUTH_TOKEN: token } })

    console.log(`[publish-github-packages] ${name}@${version} -> ${GH_PACKAGES_REGISTRY} ok`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error) {
  console.error(`[publish-github-packages] failed: ${error.message}`)
  process.exit(1)
}
