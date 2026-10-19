# Contributing to opencode-devcontainers

Thanks for your interest in contributing!

## Development Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/timlaing/opencode-devcontainers.git
   cd opencode-devcontainers
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Install the devcontainer CLI (required for devcontainer operations):

   ```bash
   npm install -g @devcontainers/cli
   ```

4. Set up the plugin for local testing:
   ```bash
   # Link plugin to OpenCode plugins directory
   mkdir -p ~/.config/opencode/plugins
   ln -sf "$(pwd)/plugin" ~/.config/opencode/plugins/opencode-devcontainers

   # Add to opencode.json
   # "plugin": ["/path/to/opencode-devcontainers/plugin"]
   ```

## Running Tests

Run the full test suite:

```bash
npm test
```

Run tests in watch mode:

```bash
npm run test:watch
```

Run tests with coverage (the same measurement CI uploads for SonarQube):

```bash
npm run test:coverage
```

## Project Structure

```
opencode-devcontainers/
├── plugin/
│   ├── index.js           # Plugin entry point (tools + bash interception)
│   ├── helpers.js          # Utility functions
│   ├── command/
│   │   ├── devcontainer.md # /devcontainer command definition
│   │   ├── worktree.md     # /worktree command definition
│   │   └── workspaces.md   # /workspaces command definition
│   └── core/               # Core modules
│       ├── index.js        # Public API exports
│       ├── clones.js       # Clone management
│       ├── config.js       # Override config generation
│       ├── devcontainer.js # Devcontainer CLI operations
│       ├── git.js          # Git operations (clone, worktree, etc.)
│       ├── jobs.js         # Background job tracking
│       ├── paths.js        # Path constants and migration
│       ├── ports.js        # Port allocation
│       ├── worktree.js     # Worktree workspace management
│       └── workspaces.js   # Unified workspace listing/cleanup
├── skill/
│   └── ocdc/
│       └── SKILL.md        # Agent skill documentation
└── test/
    └── unit/               # Unit tests
```

## Writing Tests

Tests use Node.js built-in test runner. Example:

```javascript
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

describe("myFeature", () => {
  beforeEach(() => {
    // Setup
  });

  afterEach(() => {
    // Cleanup
  });

  test("does something", () => {
    assert.strictEqual(actual, expected);
  });
});
```

## Code Style

- Use ES modules (`import`/`export`)
- Use async/await for async operations
- Handle errors explicitly
- Add JSDoc comments for public functions

## Submitting Changes

1. Create a feature branch: `git checkout -b my-feature`
2. Make your changes
3. Run tests: `npm test`
4. Commit with conventional commit message:
   - `feat:` for new features
   - `fix:` for bug fixes
   - `docs:` for documentation
   - `refactor:` for refactoring
   - `test:` for tests
   - `chore:` for maintenance
5. Push and open a pull request

Pull request titles must also use Conventional Commits; the
`conventional pull request title` workflow rejects anything else.

## Labels and triage

Issue forms set `bug` or `enhancement` and `needs-triage`. Automation adds a
component label from the bug form. Maintainers remove `needs-triage` after
review and can adjust labels manually. PRs receive labels from changed paths,
conventional title prefixes (`fix:`, `feat:`, `docs:`, `ci:`, `test:`, `build:`),
and Dependabot authorship. Automatic labels are additive and preserve manual
labels. The label definitions are in [.github/labels.json](.github/labels.json).

## Stale issues and pull requests

The stale workflow marks issues with no activity for 60 days and pull requests
with no activity for 30 days, then closes them after a further 14 days. Draft
PRs, items with milestones, and items labeled `keep-open`, `security`, or
`priority: high` are exempt.

## Dependency updates

Dependabot opens weekly grouped PRs for GitHub Actions and npm dependencies.
CI runs `npm audit` on every pull request as the `npm dependency
vulnerabilities` check.

## SonarQube analysis

The `SonarQube` workflow follows successful `CI` runs for main pushes and
same-repository pull requests. CI uploads test coverage as an artifact; the
scan downloads it from that exact run and waits for the quality gate. It uses
trusted workflow arguments, removes PR-controlled scanner properties, and does
not execute repository code with the Sonar credential.
`sonar-project.properties` documents the same source/test layout for local
analysis.

Project: `timlaing_opencode-devcontainers`, organization: `timlaing`, service:
`https://sonarcloud.io`. Enable GitHub variable `SONAR_ENABLED=true` and supply
Actions secret `SONAR_TOKEN` only after the Sonar project exists with matching
visibility. Disable Sonar automatic analysis when using this CI workflow. A
missing credential fails an enabled scan; disabled scanning is explicitly
skipped. The SonarQube badges in the README stay blank until the project
exists.

## Releasing

Releases are automated via semantic-release:

1. Merge PR to main
2. CI analyzes commit messages and determines version bump
3. Publishes to npm automatically
4. Creates GitHub release

No manual version bumping needed - just use conventional commits!
