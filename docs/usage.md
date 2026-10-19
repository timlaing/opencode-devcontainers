# Usage

## Targeting a devcontainer

```
/devcontainer feature-x    # Start/target a devcontainer for this branch
/devcontainer myapp/main   # Target a specific repo/branch
/devcontainer              # Show current status
/devcontainer off          # Disable — run commands on the host
/devcontainer rm <branch>  # Remove a devcontainer workspace
/devcontainer rm all       # Remove all devcontainer workspaces
```

The first time you target a branch, the plugin:

1. Clones the repository into `~/.local/share/opencode/clone/<repo>/<branch>/`
2. Copies gitignored secrets (`.env`, credentials, etc.) from the main repo
3. Generates an ephemeral override config with a unique forwarded port
4. Starts the container with `devcontainer up` **in the background**

Because builds can take minutes, the session is marked as _starting_: the agent
gets a friendly "container is still starting" response instead of a cryptic
failure until the job completes.

## How command routing works

Once a devcontainer is targeted for the session, shell commands are wrapped in
`devcontainer exec --workspace-folder <workspace> -- <command>` and therefore
run inside the container.

Three things run on the **host** instead:

- **Git and file commands** (`git`, `gh`, `cat`, `grep`, `ls`, …) — the repo
  is mounted into the container, and running these on the host keeps snapshots
  and diffs accurate
- **Explicit escapes** — prefix any command with `HOST:` to force host
  execution:

  ```
  HOST: docker ps
  ```

- **Commands with a foreign working directory** — if the agent sets a workdir
  outside the targeted workspace, the command is left untouched

`/devcontainer off` (or a session with no target) returns everything to normal.

## The tools

The slash command is sugar over two tools the agent can also call directly:

| Tool                | Purpose                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `devcontainer`      | Target, inspect, disable, or remove devcontainers for the session |
| `devcontainer_exec` | Execute a command inside the session's devcontainer               |

## Worktrees (OpenCode V1 only)

!!! note "V2 users"
OpenCode V2 supports worktrees natively — use the built-in
`worktree_create` / `worktree_list` / `worktree_remove` utilities and the
`worktree` configuration instead of this plugin. The `/worktree` and
`/workspaces` commands only exist in the V1 plugin API.

```
/worktree feature-x        # Create/target a worktree for this branch
/worktree myapp/main       # Target a specific repo/branch
/worktree                  # Show current status
/worktree off              # Disable — run commands in the original directory
```

Worktrees provide lightweight filesystem isolation: bash commands run in the
worktree directory, and gitignored files are copied from the main repo.

### Port/database isolation with worktrees

Configure your `.envrc` to derive `PORT` and database settings from the
worktree name to avoid conflicts:

```bash
# .envrc
export BRANCH_NAME=$(basename $(pwd))
export PORT=$((3000 + $(echo "$BRANCH_NAME" | cksum | cut -d' ' -f1) % 1000))
export DATABASE_URL="postgres://localhost/${BRANCH_NAME//-/_}_development"
```

## Workspace management (OpenCode V1 only)

```
/workspaces                # List all workspaces (clones + worktrees)
/workspaces cleanup        # Find stale workspaces (not used in 7+ days)
```

## When to use what

| Use case                             | Recommendation                            |
| ------------------------------------ | ----------------------------------------- |
| Project has a devcontainer.json      | `/devcontainer`                           |
| Different dependencies per branch    | `/devcontainer`                           |
| Testing migrations/databases         | `/devcontainer`                           |
| Quick branch work, same dependencies | `/worktree` (V1) or native worktrees (V2) |
| No Docker or Podman available        | `/worktree` (V1) or native worktrees (V2) |

## Automation

When using [opencode-pilot](https://github.com/athal7/opencode-pilot) for
automated issue processing, configure your `repos.yaml` to start an isolated
devcontainer per issue:

```yaml
repos:
  myorg/myrepo:
    session:
      prompt_template: |
        /devcontainer issue-{number}

        {title}

        {body}
```

## Known issues

**OpenCode Desktop shows changes from the wrong directory.** When switching
workspaces with `/devcontainer`, OpenCode's internal directory context doesn't
update — the "Session changes" panel keeps showing diffs from the original
directory. Workaround: start OpenCode directly in the target directory, or use
separate terminal sessions per workspace.
([anomalyco/opencode#6697](https://github.com/anomalyco/opencode/issues/6697))
