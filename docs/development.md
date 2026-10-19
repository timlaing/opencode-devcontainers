# Development

## Repository layout

| Path                 | Contents                                               |
| -------------------- | ------------------------------------------------------ |
| `plugin/index.js`    | Combined V1+V2 entrypoint (the npm package main)       |
| `plugin/v1.js`       | V1 implementation (`server()` entrypoint)              |
| `plugin/v2.js`       | V2 implementation (`setup(ctx)` entrypoint)            |
| `plugin/handlers.js` | Shared handler logic used by both entrypoints          |
| `plugin/core/`       | Core logic: clones, containers, ports, jobs, worktrees |
| `plugin/command/`    | V1 command file templates                              |
| `test/unit/`         | Node test-runner suites + shared harness               |
| `docs/`              | MkDocs Material documentation (this site)              |

## Running the tests

```sh
npm ci
npm test               # full suite
npm run test:watch     # watch mode
npm run test:coverage  # coverage report (lcov in coverage/)
```

The suites are hermetic: external commands (`devcontainer`, `docker`) are
replaced with fake executables placed on `PATH`, and every stateful directory
is redirected via `OCDC_*` environment variables into a per-test temp
directory. The shared harness lives in `test/unit/harness.js`.

- `test/unit/plugin.test.js` — the V1 implementation (`server()`): factory,
  all four tools, and the `tool.execute.before` hook
- `test/unit/plugin-v2.test.js` — the V2 implementation (`setup()`): the fake
  plugin context's registrations (command, tools, hook), the executors, and
  the shell interception hook
- `test/unit/core.*.test.js` — the core modules

CI also verifies that the combined entrypoint loads as a recognized plugin
under the current OpenCode V2 release (`opencode plugin list` must report the
plugin's ID).

## Documentation

The site is built with [MkDocs Material](https://squidfunk.github.io/mkdocs-material/):

```sh
pip install mkdocs-material
mkdocs serve    # live preview at http://127.0.0.1:8000
mkdocs build    # static site in site/
```

The site deploys automatically from `main` via the `docs` workflow
whenever `docs/`, `mkdocs.yml`, or the workflow file changes.

## Releasing

Releases are fully automated by [semantic-release](https://semantic-release.gitbook.io/)
from the `Release` job on `main`:

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, …) — enforced by CI on PR titles
- A merge commit containing `feat` or `fix` triggers a new npm release and a
  GitHub release
- Publishing uses npm trusted publishing (OIDC) with provenance — no long-lived
  npm tokens

The first release of this fork starts at `1.0.0` under the
`@timlaing/opencode-devcontainers` name.

## Pull requests

- All PRs require review approval from Sourcery or CodeRabbit before merging
- The SonarCloud quality gate must pass (line coverage ≥ 80%)
- PR titles must use Conventional Commit format
