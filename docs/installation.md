# Installation

The package is published on npm as
[`@timlaing/opencode-devcontainers`](https://www.npmjs.com/package/@timlaing/opencode-devcontainers).
OpenCode installs npm plugins automatically when they appear in your
configuration.

## OpenCode V2

Add the plugin to `opencode.json(c)` — globally
(`~/.config/opencode/opencode.json`) or per project:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@timlaing/opencode-devcontainers"],
}
```

You can pin a version with `@timlaing/opencode-devcontainers@1.2.3`, or pass
options with the object form:

```jsonc
{
  "plugins": [{ "package": "@timlaing/opencode-devcontainers", "options": {} }],
}
```

Verify the plugin loads:

```sh
opencode plugin list
```

`opencode-devcontainers` should appear with its version.

## OpenCode V1 (≥ 1.18.29)

Add to `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["@timlaing/opencode-devcontainers"],
}
```

## OpenCode V1 (< 1.18.29)

Older V1 releases predate the combined V1/V2 entrypoint. Pin the last
V1-only release:

```jsonc
{
  "plugin": ["opencode-devcontainers@0.5.1"],
}
```

!!! note "Package rename"
`opencode-devcontainers@0.5.1` and earlier were published under the
unscoped name by the original author. This fork publishes under the
`@timlaing` scope.

## Dependencies

- **devcontainer CLI** — required for the devcontainer functionality:

  ```sh
  npm install -g @devcontainers/cli
  ```

- **Docker or Podman** — the container runtime used by the devcontainer CLI.
  The plugin auto-detects either; see
  [Configuration](configuration.md) to pin specific executables.

- **git** — used to clone repositories into workspaces.

## Support matrix

| OpenCode     | Config key | Package                                     | Devcontainers | Worktrees |
| ------------ | ---------- | ------------------------------------------- | ------------- | --------- |
| V2 (2.x)     | `plugins`  | `@timlaing/opencode-devcontainers` (latest) | ✅            | Native    |
| V1 ≥ 1.18.29 | `plugin`   | `@timlaing/opencode-devcontainers` (latest) | ✅            | ✅        |
| V1 < 1.18.29 | `plugin`   | `opencode-devcontainers@0.5.1`              | ✅            | ✅        |
