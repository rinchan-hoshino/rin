# Rin / Pi integration boundary

Rin keeps Pi as an upstream npm dependency. Rin may depend on a small number of
Pi implementation details, but those seams must be owned in one place so Pi can
still be upgraded intentionally.

## Rules

- Do not import `node_modules/@earendil-works/pi-coding-agent/dist/...` outside
  `src/core/pi/private-api.ts`.
- Do not access selected Pi private session/manager members outside
  `src/core/pi/session-host.ts` or the local bridge under `src/core/pi/`.
- Product modules such as memory, self-improve, chat, daemon, and token usage
  should depend on Rin facades, not Pi private fields.
- When adding a new Pi private seam, add a semantic helper in `src/core/pi/`,
  document it below, and update the guard test in `tests/unit/pi-dependencies.test.ts`.

## Current seams

| Seam                                                                   | Local owner                                | Why it exists                                                                                                                         | Guard                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Pi private imports for TUI theme, config, key hints, and managed tools | `src/core/pi/private-api.ts`               | Pi does not export every TUI/helper symbol Rin needs for its current shell and installer                                              | `Pi private imports stay centralized`                       |
| Pi session/manager private methods and fields                          | `src/core/pi/session-host.ts`              | Rin customizes prompt materialization, compaction, persistence, tool refresh, and model/tool events while still using Pi AgentSession | `Pi session private members stay behind Rin's session host` |
| Rin capability bridge into Pi extension lifecycle                      | `src/core/pi/internal-extension-bridge.ts` | Rin first-party capabilities need selected Pi lifecycle events without pretending every capability is a standalone Pi package         | `Pi session private members stay behind Rin's session host` |
| TUI patch implementation                                               | `src/core/pi/tui-patches/index.ts`         | Rin currently has a local TUI shell layered on Pi interactive mode; all prototype patching stays inside the integration area          | focused TUI override tests                                  |

## Upgrade workflow

1. Upgrade Pi packages and upstream mirror metadata together.
2. Run `npm run build` and the focused Pi integration tests:
   - `tests/unit/pi-dependencies.test.ts`
   - `tests/unit/tui-overrides.test.ts`
   - `tests/unit/rin-runtime.test.ts`
   - `tests/unit/rpc-mode.test.ts`
3. If a private seam breaks, fix the helper in `src/core/pi/` first. Do not
   scatter fallback accesses through product code.
