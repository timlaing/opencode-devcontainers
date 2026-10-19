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
