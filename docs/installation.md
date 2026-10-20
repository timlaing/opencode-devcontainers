# Installation

The package is published to **both** registries as
`@timlaing/opencode-devcontainers`:

- **npmjs** (recommended) —
  [`@timlaing/opencode-devcontainers`](https://www.npmjs.com/package/@timlaing/opencode-devcontainers).
  Public reads need no token, so this is the default for most setups.
- **GitHub Packages** —
  [packages](https://github.com/timlaing/opencode-devcontainers/packages).
  Requires a token for every operation, even reads. Useful if your scope is
  already mapped to `npm.pkg.github.com`, or as a fallback.

OpenCode installs npm plugins automatically when they appear in your
configuration. Because both registries use the `@timlaing` scope, a
`.npmrc` scope mapping decides which one resolves — see
[Registry setup](#registry-setup).

## Registry setup

npm/bun resolve the `@timlaing` scope through whatever the scope is mapped
to in `.npmrc`. Do **one** of the following — per project (next to where you
run OpenCode) or globally in `~/.npmrc`:

**npmjs (recommended, no token):**

```ini
@timlaing:registry=https://registry.npmjs.org
```

**GitHub Packages (token required for reads):**

```ini
@timlaing:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

then export a token with the `read:packages` scope (a classic PAT —
GitHub's npm registry does not accept fine-grained tokens):

```sh
export NODE_AUTH_TOKEN=github_pat_...
```

If your OpenCode install uses a package manager that ignores `.npmrc`
scope mappings, install the plugin from git instead — no registry auth
needed:

```jsonc
{
  "plugins": ["github:timlaing/opencode-devcontainers"],
}
```

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

`opencode-devcontainers` should appear with its version. This lists
user-scoped plugins; on a fresh machine it does not list project-scoped
plugins. If you installed the plugin per project, verify it from inside an
OpenCode session instead — the `/devcontainer` command should be available.

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
    `opencode-devcontainers@0.5.1` and earlier were published on npmjs under
    the unscoped name by the original author (that registry needs no scope
    mapping). This fork publishes the `@timlaing`-scoped package on npmjs
    (canonical) and mirrors it to GitHub Packages.

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
