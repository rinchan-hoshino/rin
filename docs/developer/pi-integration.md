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

| Seam                                                                         | Local owner                                | Why it exists                                                                                                                                                        | Guard                                                       |
| ---------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Pi private imports for TUI config, key hints, theme state, and managed tools | `src/core/pi/private-api.ts`               | Pi does not export every TUI/helper symbol Rin needs for its current shell and installer; public exports are preferred when available                                | `Pi private imports stay centralized`                       |
| Pi session/manager private methods and fields                                | `src/core/pi/session-host.ts`              | Rin uses public `resourceLoader`/`extensionRunner` getters when available, then centralizes remaining prompt, compaction, persistence, tool refresh, and event seams | `Pi session private members stay behind Rin's session host` |
| Rin capability bridge into Pi extension lifecycle                            | `src/core/pi/internal-extension-bridge.ts` | Rin first-party capabilities need selected Pi lifecycle events without pretending every capability is a standalone Pi package                                        | `Pi session private members stay behind Rin's session host` |
| TUI patch implementation                                                     | `src/core/pi/tui-patches/index.ts`         | Rin currently has a local TUI shell layered on Pi interactive mode; all prototype patching stays inside the integration area                                         | focused TUI override tests                                  |

## Pi update rule

Rin does not try to be a zero-loss wrapper around Pi's app layer. Instead, Pi
updates follow two rules:

1. If a Pi behavior can be carried as a public parser result, service option,
   resource-loader option, session option, or JSON startup option bag, add or
   reuse that passthrough path so future updates of the same class need no new
   feature-specific code.
2. If a Pi behavior cannot be carried that way, adapt it only at the finite
   Rin-owned entrypoint that wraps the matching Pi surface. Do not scatter
   feature-specific patches through product modules.

Finite entrypoints for non-passthrough follow-up:

- CLI and non-interactive print mode: `src/core/rin/run.ts` and
  `src/core/rin/main.ts`.
- TUI startup and interactive-only behavior: `src/core/rin-tui/`.
- Shared session/runtime creation for chat, daemon, scheduled tasks, SDK calls,
  and TUI-created sessions: `src/core/rin-lib/runtime.ts` and
  `src/core/session/factory.ts`.
- Pi service/resource creation: `src/core/rin-lib/agent-runtime.ts`.
- Cross-process option transport: `src/core/rin-daemon/worker.ts`,
  `src/core/chat/`, and `src/core/rin-frontend-sdk/turn-driver.ts`.
- Private Pi symbols: `src/core/pi/` only.

## Upgrade workflow

1. Upgrade Pi packages and upstream mirror metadata together.
2. Read the Pi delta and classify each behavior change as either passthrough,
   finite-entrypoint follow-up, intentional Rin difference, or missing upstream
   hook.
3. Run `npm run build` and the focused Pi integration tests:
   - `tests/unit/pi-dependencies.test.ts`
   - `tests/unit/tui-overrides.test.ts`
   - `tests/unit/rin-runtime.test.ts`
   - `tests/unit/rpc-mode.test.ts`
4. If a private seam breaks, fix the helper in `src/core/pi/` first. Do not
   scatter fallback accesses through product code.
