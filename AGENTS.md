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

After a PR is merged to main, semantic-release automatically:

1. Creates a new version based on commit messages
2. Publishes to the GitHub Packages npm registry (`npm.pkg.github.com`)
3. Creates a GitHub release

### Verify Release

```bash
gh release list -R timlaing/opencode-devcontainers -L 1
npm view @timlaing/opencode-devcontainers version --registry https://npm.pkg.github.com
```

GitHub Packages requires authentication even for reads of public
packages; add `//npm.pkg.github.com/:_authToken=$NODE_AUTH_TOKEN` to
`~/.npmrc` and export a token with `read:packages`, or the `npm view`
call fails.

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
