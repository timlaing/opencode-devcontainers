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
| `scripts/`           | End-to-end check against a real V2 runtime             |
| `docs/`              | MkDocs Material documentation (this site)              |

## Running the tests

```sh
npm ci
npm test               # full suite
npm run test:watch     # watch mode
npm run test:coverage  # coverage report (lcov in coverage/)
npm run e2e:v2         # end-to-end check against a real V2 runtime
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

CI also verifies that the combined entrypoint imports cleanly and exposes the
exact shape OpenCode's V2 loader requires (default export with `id` + `setup`)
alongside the V1 `server()` entrypoint. Loading in a live OpenCode V2 runtime
was validated against OpenCode 2.0.30 (`opencode plugin list` reports the
plugin's ID); note that `opencode plugin list` on a fresh machine does not
list project-scoped plugins, which is why CI asserts the entrypoint contract
directly instead of driving the CLI.

## End-to-end check (V2)

`scripts/e2e-v2.mjs` loads the plugin through OpenCode's real V2 plugin
loader and drives it over the HTTP API of a sandboxed `opencode serve`
instance, asserting the behaviors the unit tests' fake context cannot:

- plugin registration (state `active`) and the `/devcontainer` command in
  the real command registry
- `POST /session/{id}/command` execution: `$ARGUMENTS` substitution and
  `ctx.session.prompt` forwarding
- real agent-loop tool dispatch (`devcontainer`, `devcontainer_exec`) and
  background container start (clone + shimmed `devcontainer up`)
- the `execute.before` shell hook rewriting `npm test` into
  `devcontainer exec ...` (asserted on the tool result, which only the
  wrapped command can produce)
- multi-session routing (an unbound session runs on the host, with no
  leaked session state)
- stale-session cleanup at init against the real session store, including
  preservation of active sessions across a server restart

Only external dependencies are faked: a scripted OpenAI-compatible server
plays the model (canned tool calls, so the check is deterministic, offline,
and free), and `devcontainer`/`docker` are PATH shims. Every OpenCode
process runs with a sandboxed `HOME` and `OCDC_*` state directories; the
script never touches your real OpenCode service or providers.

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
