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
2. Publishes to npm
3. Creates a GitHub release

### Verify Release

```bash
gh release list -R timlaing/opencode-devcontainers -L 1
npm view opencode-devcontainers version
```

### Upgrade

OpenCode automatically updates npm plugins on startup. Just restart OpenCode.

To force a specific version:

```json
{
  "plugin": ["opencode-devcontainers@1.0.0"]
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
