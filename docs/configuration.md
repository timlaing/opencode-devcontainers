# Configuration

## Config file

`~/.config/opencode/devcontainers/config.json`:

```json
{
  "portRangeStart": 13000,
  "portRangeEnd": 13099,
  "dockerPath": "podman",
  "dockerComposePath": "podman-compose"
}
```

| Key                 | Default | Description                             |
| ------------------- | ------- | --------------------------------------- |
| `portRangeStart`    | `13000` | First port of the auto-allocation range |
| `portRangeEnd`      | `13099` | Last port of the auto-allocation range  |
| `dockerPath`        | auto    | Container runtime executable            |
| `dockerComposePath` | auto    | Compose executable                      |

`dockerPath` and `dockerComposePath` are optional. When unset, the plugin uses
Docker when available, otherwise Podman. A Podman runtime requires either
`podman-compose` or `docker-compose`; the plugin detects one automatically and
reports an unsupported configuration when neither is available. Set both paths
explicitly to use nonstandard executable locations.

## Tool permissions (V2)

The V2 `devcontainer` tool declares the permission key `devcontainer`, so you
can require explicit approval before it runs — including remove operations —
through OpenCode's permission configuration:

```json
{
  "permissions": [
    { "action": "devcontainer", "resource": "*", "effect": "ask" }
  ]
}
```

The remove flow always shows its warnings (uncommitted changes, other active
sessions) before doing anything, but those confirmations happen in the chat
and are enforced by the model. Gating the tool itself with a permission is the
independently enforced option if you want a user-approval step that the model
cannot skip.

## Environment variables

Override the default locations (mainly useful for testing or unusual setups):

| Variable             | Default                            |
| -------------------- | ---------------------------------- |
| `OCDC_CONFIG_DIR`    | `~/.config/opencode/devcontainers` |
| `OCDC_CACHE_DIR`     | `~/.cache/opencode-devcontainers`  |
| `OCDC_CLONES_DIR`    | `~/.local/share/opencode/clone`    |
| `OCDC_WORKTREES_DIR` | `~/.local/share/opencode/worktree` |
| `OCDC_SESSIONS_DIR`  | `<cache>/opencode-sessions`        |

## On-disk layout

| Path                        | Contents                                                  |
| --------------------------- | --------------------------------------------------------- |
| `<clones>/<repo>/<branch>/` | Per-branch devcontainer workspace (a git clone)           |
| `<cache>/ports.json`        | Port allocations per workspace                            |
| `<cache>/overrides/`        | Ephemeral `docker-compose` override configs (unique port) |
| `<cache>/jobs.json`         | Background startup job state                              |
| `<sessions>/`               | Per-session targeting state                               |
