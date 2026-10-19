// Combined V1 + V2 entrypoint (the officially supported dual shape, see
// https://opencode.ai/v2/docs/build/plugins/migrate-v1):
//   - OpenCode V2 loads the Plugin.define() definition and calls setup(ctx),
//     registering the devcontainer tools, the /devcontainer command, and the
//     shell interception hook (worktrees are native in V2).
//   - OpenCode V1 (>= 1.18.29) calls server() with the classic { client }
//     argument, registering the full V1 tool set (devcontainer, worktree,
//     workspaces) and the tool.execute.before hook.
// Older V1 releases (< 1.18.29) should pin opencode-devcontainers@0.5.1.
import { Plugin } from "@opencode/plugin"

import { devcontainers } from "./v1.js"
import { setup } from "./v2.js"

// Named re-export kept for direct consumers and the test suite
export { devcontainers }

export default {
  ...Plugin.define({
    id: "opencode-devcontainers",
    setup,
  }),
  server: devcontainers,
}
