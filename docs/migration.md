# Migrating to OpenCode V2

This page covers what changes when you move an existing setup to OpenCode V2,
and answers the questions from
[issue #1](https://github.com/timlaing/opencode-devcontainers/issues/1).

## TL;DR

1. Update the config key and restart OpenCode:

   ```jsonc
   // V1
   { "plugin": ["@timlaing/opencode-devcontainers"] }

   // V2
   { "plugins": ["@timlaing/opencode-devcontainers"] }
   ```

2. Keep using `/devcontainer` exactly as before.
3. If you used `/worktree` or `/workspaces`, switch to OpenCode V2's native
   worktree support.

## What changed and why

OpenCode V2 introduced a new plugin API. V1 plugin _implementations_ do not run
in V2 at all — this package therefore ships a combined entrypoint that exposes
both APIs from one default export:

- **V2** loads the `Plugin.define({ id, setup })` definition and registers the
  devcontainer tools, the `/devcontainer` command, and the shell interception
  hook through `ctx.tool.transform`, `ctx.command.transform`, and
  `ctx.tool.hook("execute.before")`.
- **V1 (≥ 1.18.29)** calls `server()` and registers the full V1 tool set, as
  before.

Internally both entrypoints share the same handler core
(`plugin/handlers.js` and `plugin/core/`), so behavior is identical across
versions and covered by one test suite.

### Devcontainers: unchanged behavior

Everything about the devcontainer workflow is preserved:

- Branch targeting, background startup, and the "still starting" feedback
- Port allocation and ephemeral override configs
- Session isolation (each session remembers its own container)
- Command routing with automatic host execution for git/file commands
- The `HOST:` escape prefix
- `/devcontainer rm` and workspace cleanup

### Worktrees: use the native V2 support

OpenCode V2 has first-class worktrees: a `worktree` configuration key,
`worktree_create` / `worktree_list` / `worktree_remove` utilities, a
`ctx.worktree` plugin API, and inventory tracking per project. Because of that,
**this plugin does not register its V1 worktree tooling under V2** — the V2
plugin exposes only the devcontainer functionality.

To migrate a worktree workflow:

```sh
# V1
/worktree feature-x

# V2 equivalent — native support
# (create the worktree, then move the session into it)
```

V2-native worktrees also handle the "workdir" routing that the V1 plugin's
`/worktree` mode implemented, so no interception hook is needed for them.

### Command files → command registration

Under V1 the plugin copied command files (`devcontainer.md`, …) into your
config directory. Under V2 it registers the `/devcontainer` command directly
via the plugin API — nothing is written to your config directory, and stale
copies of the old command files are no longer installed.

If you used the V1 plugin before upgrading, delete the command files it
installed so the obsolete `/worktree` and `/workspaces` commands (and a
duplicate `/devcontainer`) do not linger as user commands in V2:

```sh
rm -f ~/.config/opencode/command/devcontainer.md \
      ~/.config/opencode/command/worktree.md \
      ~/.config/opencode/command/workspaces.md
```

Only remove these files if they came from the plugin — if you authored your
own commands with these names, keep them.

## Support policy

| OpenCode     | Supported package version                   | Notes                                      |
| ------------ | ------------------------------------------- | ------------------------------------------ |
| V2 (2.x)     | `@timlaing/opencode-devcontainers` (latest) | Devcontainers only; worktrees are native   |
| V1 ≥ 1.18.29 | `@timlaing/opencode-devcontainers` (latest) | Full V1 feature set                        |
| V1 < 1.18.29 | `opencode-devcontainers@0.5.1`              | Last release of the archived upstream line |

V1 support is provided by the same package and is tested by the same suite;
there are no plans to drop it while the `server()` entrypoint remains
supported by V1. The V1 code path will be removed only if a future OpenCode
release removes V1 plugin loading entirely.

## Migrating state from V1

Session files and workspace state live under `~/.cache/opencode-devcontainers`
and are format-compatible — no migration is needed. Stale session files are
cleaned up automatically at startup, exactly as under V1.

If you previously ran the unscoped `opencode-devcontainers` package, remove the
old config entry before adding the scoped one so both are not loaded:

```sh
opencode plugin remove opencode-devcontainers
opencode plugin add @timlaing/opencode-devcontainers
```
