#!/usr/bin/env node
/**
 * Mirror the freshly released package to the GitHub Packages npm registry.
 *
 * The publish job publishes the canonical version to npmjs (the default
 * registry) via trusted publishing, with provenance. That publish is the
 * source of truth: it carries the version, the git tag, and the GitHub
 * Release. This script runs as a separate step afterward and pushes the
 * *same* version to GitHub Packages, so consumers who resolve the `@timlaing`
 * scope through `npm.pkg.github.com` get an identical artifact.
 *
 * Because the publish job stamps the release version (from the release tag)
 * into the checked-out package.json before running, a plain `npm publish`
 * here packs the identical contents — no separate packing logic needed.
 *
 * Retry safety: if a mirror publish fails, re-running the publish job lands
 * on the already-stamped version and mirrors it; when there is no stamp at
 * all, the script falls back to the latest release tag: if that version is
 * on npmjs but missing from GitHub Packages, it publishes from a detached
 * `git worktree` of the tag, so the retried artifact still matches the
 * released commit exactly.
 *
 * Auth is a temporary `.npmrc` with a `//npm.pkg.github.com/:_authToken`
 * line resolved from `NODE_AUTH_TOKEN` (set to `GITHUB_TOKEN` by the publish
 * job, which carries the `packages: write` permission). Passing
 * `--userconfig` keeps the `@timlaing` scope mapping in the repo `.npmrc`
 * from hijacking the explicit `--registry`.
 *
 * npm allows only one provenance source per version, so this publish omits
 * `--provenance` to stay symmetric with the token-auth npmjs publish.
 *
 * Safety: dry run by default; `--publish` publishes for real. An
 * already-published version is skipped with a log (registry versions are
 * immutable, so it means a prior run already mirrored it — re-running the
 * job stays safe); a missing token still fails loudly.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
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
 * @returns {{ name: string, version: string }} package identity; in the
 *   publish job the version is the release version stamped from the release
 *   tag before this script runs.
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
 *   the newest tag does not match the repo's `v<semver>` release tag format.
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

async function main() {
  const { name, version } = readPkg()
  const dryRun = !process.argv.includes('--publish')
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.NODE_AUTH_TOKEN

  // The publish job stamps the released version (from the release tag) into
  // the working package.json before running this script; outside that job
  // the working version equals the committed placeholder. So a working
  // version different from the committed one means "the publish job just
  // stamped the version to mirror", and equality means "no stamp" — handled
  // below by the release-tag fallback. The job also exports RELEASE_TAG,
  // which is authoritative when present (it removes the equality
  // ambiguity), and the stamped version must match it.
  const committed = JSON.parse(
    execFileSync('git', ['show', 'HEAD:package.json'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  )
  const releaseTag = process.env.RELEASE_TAG
  if (releaseTag && version !== releaseTag.replace(/^v/, '')) {
    throw new Error(`working package.json version ${version} does not match release tag ${releaseTag}; refusing to mirror`)
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
  // publishCwd is where `npm publish` packs from: the CI checkout on the
  // stamped path, a detached worktree of the release tag on the retry path.
  let publishCwd = repoRoot
  let target = version
  try {
    // Full nerf-dart key: `//npm.pkg.github.com/:_authToken` — the colon
    // before the setting name is required as much as the trailing slash.
    writeFileSync(userconfig, `${GH_HOST}:_authToken = \${NODE_AUTH_TOKEN}\n`)

    if (committed.version !== version || releaseTag) {
      // Stamped path: the publish job stamped the release version into this
      // checkout before running. RELEASE_TAG (exported by that job) is
      // authoritative over the version-equality heuristic, which is
      // ambiguous when the released version happens to equal the committed
      // placeholder — verify the stamp matches the release tag before
      // trusting it. Without a token the duplicate check cannot run (GitHub
      // Packages refuses anonymous reads); that only happens in a dry run,
      // which publishes nothing, so skipping the guard is safe. `--publish`
      // runs already threw above when no token was resolved. An
      // already-mirrored version means a previous run of this job succeeded
      // — registry versions are immutable, so the mirror invariant holds;
      // skip with a log so re-running the job is safe.
      if (token && alreadyPublished(name, version, userconfig, token)) {
        console.log(`[publish-github-packages] ${version} already on ${GH_PACKAGES_REGISTRY}; nothing to mirror`)
        return
      } else if (!token) {
        console.log('[publish-github-packages] dry run without a token: skipping duplicate-version check')
      }
    } else {
      // No stamp: not the publish job (or a run from a checkout without the
      // stamp). Nothing to mirror in the common case — but the latest
      // release tag may still be missing from GitHub Packages (for example
      // after a mirror failure that predated a job re-run with the stamp).
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
      // stamped version); stamp the tag tree exactly like the publish job's
      // stamp step does for the canonical publish so the retried artifact is
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
      // No lifecycle code runs while publishing (the root package defines
      // none; this keeps third-party scripts out of the credential-bearing
      // publish step in CI).
      '--ignore-scripts',
      '--userconfig',
      userconfig,
      ...(dryRun ? ['--dry-run'] : []),
    ]

    console.log(
      `[publish-github-packages] ${name}@${target} -> ${GH_PACKAGES_REGISTRY}${dryRun ? ' (dry run; pass --publish to publish)' : ''}`
    )

    // Stream npm's output live to the console (a hung publish keeps its
    // diagnostics visible even if a job timeout kills the step — buffered
    // captures only flush after exit) while watching stderr for the
    // duplicate-conflict markers. Each write honors the sink's
    // backpressure (pause the child stream until 'drain'): a producer
    // faster than the log sink cannot queue unbounded chunks in memory.
    // The conflict watch is sticky over a rolling window: once any window
    // has contained a marker it stays seen regardless of how much trailing
    // output arrives afterwards, and npm's single-line conflict message is
    // far smaller than the window, so it cannot slip through either edge.
    const status = await new Promise((resolve, reject) => {
      const child = spawn('npm', args, {
        cwd: publishCwd,
        env: { ...process.env, NODE_AUTH_TOKEN: token },
        stdio: ['inherit', 'pipe', 'pipe'],
      })
      const conflictRe = /E409|already staged|cannot publish over/i
      const rollingCap = 64 * 1024
      let rolling = ''
      let sawConflict = false
      const attach = (source, sink, observe) => {
        source.on('data', (chunk) => {
          if (observe) observe(chunk)
          if (!sink.write(chunk)) {
            source.pause()
            sink.once('drain', () => source.resume())
          }
        })
      }
      attach(child.stdout, process.stdout)
      attach(child.stderr, process.stderr, (chunk) => {
        rolling = (rolling + String(chunk)).slice(-rollingCap)
        if (!sawConflict && conflictRe.test(rolling)) sawConflict = true
      })
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, sawConflict }))
    })

    if (status.code !== 0) {
      // A serialized duplicate run whose first mirror publish is still
      // inside the registry's consistency window gets a version conflict
      // here. That conflict (and only that conflict — the exact markers
      // npm emits for a version clash, nothing else) proves the version is
      // already present, so treat it as mirrored; every other failure
      // throws with npm's diagnostics already streamed into the log. Dry
      // runs publish nothing, so no conflict can occur and none is
      // tolerated.
      if (!dryRun && status.sawConflict) {
        console.log(
          `[publish-github-packages] ${name}@${target} already present on ${GH_PACKAGES_REGISTRY} (registry refused the duplicate publish); nothing to mirror`
        )
        return
      }
      throw new Error(`npm publish for ${name}@${target} failed with exit code ${status.code}`)
    }

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
  await main()
} catch (error) {
  console.error(`[publish-github-packages] failed: ${error.message}`)
  process.exit(1)
}
