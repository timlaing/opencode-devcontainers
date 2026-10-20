# opencode-devcontainers

An [OpenCode](https://opencode.ai) plugin for isolated branch workspaces using
devcontainers. Point a session at a branch and the plugin clones the repo,
builds and starts a devcontainer for it, and transparently routes the agent's
shell commands into that container.

!!! info "Community project"
    This is a community project and is not built by or affiliated with the
    OpenCode team.

## What it does

When you target a branch with `/devcontainer`, the plugin:

- **Clones** the repo into a per-branch workspace (gitignored secrets such as
  `.env` are copied from your main checkout)
- **Builds and starts** a devcontainer via the
  [`devcontainers/cli`](https://github.com/devcontainers/cli)
- **Allocates a unique port** from a configurable range (default 13000–13099)
  through an ephemeral override config, so parallel workspaces don't collide
- **Routes commands into the container**: once a devcontainer is targeted,
  shell commands run inside it automatically — with a `HOST:` escape hatch and
  automatic host execution for git and file-reading commands
- **Tracks session state**, so the agent remembers which container each session
  is targeting, and cleans up stale sessions and finished startup jobs

## OpenCode V1 and V2 support

One package supports both plugin APIs:

| OpenCode version | Plugin API            | Devcontainers                      | Worktrees                                  |
| ---------------- | --------------------- | ---------------------------------- | ------------------------------------------ |
| V2 (2.x)         | V2 (`plugins` config) | ✅                                 | Native — use OpenCode's built-in worktrees |
| V1 ≥ 1.18.29     | V1 (`plugin` config)  | ✅                                 | ✅ `/worktree`, `/workspaces`              |
| V1 < 1.18.29     | V1                    | pin `opencode-devcontainers@0.5.1` | pin `opencode-devcontainers@0.5.1`         |

V2 registers only the devcontainer functionality, because OpenCode V2 supports
worktrees natively (`/worktree_create` and friends). See
[Migrating to OpenCode V2](migration.md) for details.

## Quick start

```jsonc
// OpenCode V2 — opencode.json(c)
{
  "plugins": ["@timlaing/opencode-devcontainers"],
}
```

```jsonc
// OpenCode V1 (≥ 1.18.29) — ~/.config/opencode/opencode.json
{
  "plugin": ["@timlaing/opencode-devcontainers"],
}
```

Then in a session, from inside your git repository:

```
/devcontainer feature-x
```

Full instructions on the [Installation](installation.md) page.

## Requirements

- Docker (or Podman) available to the `devcontainer` CLI
- The devcontainer CLI: `npm install -g @devcontainers/cli`
- A `.devcontainer/devcontainer.json` (or `devcontainer.json`) in the target
  repository
