# Agent Instructions

## Pre-Commit: Documentation Check

Before committing changes, verify documentation is updated to reflect code changes:

1. **README.md** - Update if changes affect:
   - Plugin usage (`/devcontainer`, `/worktree`, `/workspaces` commands)
   - Configuration options (`~/.config/opencode/devcontainers/config.json`)
   - Installation steps or dependencies
   - Usage examples

2. **CONTRIBUTING.md** - Update if changes affect:
   - Development setup or workflow
   - Test commands or patterns
   - Release process
   - Project structure

3. **plugin/command/\*.md** - Update if changes affect:
   - Command arguments or behavior
   - Examples

## Post-PR: Release and Upgrade Workflow

Releases are event-driven, never push-driven: merging to main never
publishes anything. To cut a release:

1. Ensure `main` is green
2. `gh release create vX.Y.Z --target main --generate-notes` (the Releases
   UI works the same — publishing the release is what triggers the pipeline)
3. The `Publish release` job in `.github/workflows/ci.yml` triggers on the
   release event and:
   1. stamps the tag's version into the checkout (`package.json` commits a
      placeholder; the release tag is the source of truth)
   2. publishes the canonical version to npmjs (`registry.npmjs.org`), with
      provenance
   3. mirrors that version to the GitHub Packages npm registry
      (`npm.pkg.github.com`) via `scripts/publish-github-packages.mjs`
4. Re-running the publish job is safe: both publishes skip when the version
   is already present. Draft/prerelease releases are ignored by the job;
   promoting a prerelease to a stable release does publish (GitHub emits
   the `released` event for that transition). A release whose version is
   lower than the current `latest` is refused — backports are published
   manually with an explicit dist-tag. A stable release fires both the
   `published` and `released` events, so the publish job runs twice per
   release: the first run publishes; the second skips every step whose
   version it finds already present — and when it catches npm's staging
   window (`npm view` still 404 for the just-published version), it
   attempts the duplicate publish, treats the registry's version conflict
   as success, and continues to the mirror, which skips or tolerates its
   duplicate the same way. If several releases are cut in quick
   succession, GitHub keeps only one queued publish run — a superseded run
   can be re-run from the Actions tab (both publishes are idempotent, so
   re-runs never duplicate).

The npmjs publish uses **trusted publishing (OIDC)** — no npm token secret
exists in the repo. `id-token: write` lets the npm CLI exchange a
short-lived OIDC token for publish credentials; npm validates it against
the trusted publisher configured on npmjs.com. The GitHub Packages mirror
uses the job's own `GITHUB_TOKEN` (`packages: write`), also no secret.

Trusted publisher (configured once on npmjs.com → the package → Settings →
Trusted publishing → GitHub Actions, or via `npm trust github`):

| Field                | Value                                         |
| -------------------- | --------------------------------------------- |
| Organization or user | `timlaing`                                    |
| Repository           | `opencode-devcontainers`                      |
| Workflow filename    | `ci.yml`                                      |
| Environment name     | _(leave blank — the job sets no environment)_ |

Two gotchas: the workflow filename must match exactly (`ci.yml`, not the
full path), and a trusted-publisher config must complete its **first
publish within 2 days** of being created or it expires and must be
re-created. Trusted publishing also cannot create a package's first-ever
version unless the pending/first config is in place — so create the config
_before_ the first release, not after.

### Verify Release

```bash
gh release list -R timlaing/opencode-devcontainers -L 1
npm view @timlaing/opencode-devcontainers version   # npmjs (canonical)
npm view @timlaing/opencode-devcontainers version --registry https://npm.pkg.github.com
```

The npmjs lookup needs no token (public reads are open). GitHub Packages
requires authentication even for reads of public packages; add
`//npm.pkg.github.com/:_authToken=$NODE_AUTH_TOKEN` to `~/.npmrc` and
export a token with `read:packages`, or that `npm view` call fails.

### Upgrade

OpenCode automatically updates npm plugins on startup. Just restart OpenCode.

To force a specific version:

```json
{
  "plugin": ["@timlaing/opencode-devcontainers@1.0.0"]
}
```

### Config Locations

- Main config: `~/.config/opencode/devcontainers/config.json`
- Cache/state: `~/.cache/opencode-devcontainers/`
- Clones: `~/.local/share/opencode/clone/`
- Worktrees: `~/.local/share/opencode/worktree/`

If config format changed, check release notes:

```bash
gh release view -R timlaing/opencode-devcontainers
```

## Repository automation

- `main` runs CI (`Plugin tests` + `Release`), the `npm dependency vulnerabilities` audit, and the SonarQube quality gate. The SonarQube workflow fails if the `SONAR_TOKEN` secret is missing.
- Issue forms set `bug`/`enhancement` plus `needs-triage`; the `Automatic labels` workflow adds a component label from the bug form and path/conventional title labels on PRs. Labels are defined in the repository's Labels settings.
- A stale workflow marks quiet issues after 60 days and PRs after 30; the labels `keep-open`, `security` and `priority: high` are exempt.
