# Builtin Capabilities

This document helps agents distinguish Rin core capabilities from optional Pi extensions. For general usage guidance, start with `docs/capabilities.md`; use this page when you need to know whether a tool is core, optional, or background-only.

## Quick reference

- Core Rin capabilities are available through native product code when their tools are present in the live tool list.
- The core todo capability is always enabled and registers the `todo` tool plus `/todos` command.
- Rin ships `rin:web-search` as the optional bundled Pi extension alias; it is controlled through `settings.json -> extensions`.
- Fresh installs enable `rin:web-search` by default; existing installs keep their current settings until changed.
- Rin does not ship bundled Browser Use or Computer Use extensions. For those tasks, use the live tool list first, then read `practices/browser-use.md` or `practices/computer-use.md`.
- Background extensions run in Rin's background runtime and are not Pi session tools.
- The current tool list and system prompt remain authoritative for a specific turn.

## Default extra capabilities

- `memory`
  - provides `search_memory`, transcript archiving, and the searchable session-history index
- `self-improve`
  - provides compact prompt baselines, agent-managed skills, periodic review, and hidden nightly consolidation
- Rin system prompt assembly
  - adds Rin's default stance, tool guidance, configured baselines, and available skill metadata
  - keeps the effective base system prompt stable within a session until the session is refreshed or reloaded
- `message-header`
  - adds message metadata such as `sent at`; adds chat-specific context in chat bridge scenarios
- `freeze-session-runtime`
  - keeps the effective system prompt stable within a session
- `tui-input-compat`
  - smooths over some TUI input compatibility issues
- delegated subagents
  - use the non-interactive CLI pattern in `docs/non-interactive-cli.md`; do not assume a `run_subagent` tool exists unless it appears in the live tool list
- `task`
  - scheduled task operations are documented local SDK workflows rather than agent tools
  - read `~/.rin/docs/rin/docs/agent-sdk.md` and `~/.rin/docs/rin/docs/scheduled-tasks.md` before operating scheduled tasks
- `chat`
  - provides `/chat` for official adapter setup inside the TUI
  - chat sending, chat turn control, stored-message lookup, log inspection, and identity updates are documented SDK/file workflows rather than agent tools
  - `/chat` enters platform selection directly, keeps installer-only opt-in confirmation, prefers the minimum runnable fields, defaults to polling / socket modes when supported, and includes direct official links for required values
- `token-usage`
  - records detailed token telemetry under `~/.rin/data/core/usage/usage.db`
  - powers the charted `rin usage` text dashboard, grouped usage queries, and best-effort configured provider account/quota display

## Core todo capability

Rin's todo support is native core behavior, not a Pi extension.

- always enabled
- registers `todo` for branch-aware task checklists and `/todos` for the interactive TUI view
- stores state in session tool result details, so forks and session branches reconstruct the matching todo list
- remains enabled even when optional Pi extensions are disabled; it is part of Rin's reliability path rather than a user-toggleable component
- in daemon/RPC chat turns, if a final answer is produced while todos are still incomplete, Rin may withhold that final answer and silently continue work; hidden continuations stop when todos complete, when the todo state does not change between continuations, or after 64 continuations

## Bundled optional Pi extensions

Rin currently ships one optional foreground Pi extension alias:

```json
{
  "extensions": ["rin:web-search"]
}
```

- `rin:web-search`
  - expands to the bundled `extensions/rin-web-search` Pi package
  - registers `web_search`
  - gets pages directly when `q` is an HTTP(S) URL
  - uses Rin-managed SearXNG for search queries; fresh install enables this alias and prepares the SearXNG runtime, while manual enablement prepares it best-effort

Use Pi resource filters with the alias to disable entries from a broader extension list:

```json
{
  "extensions": ["rin:web-search", "!rin:web-search"]
}
```

If `extensions` is missing or `[]`, `todo` stays on by default and optional extension tools are off for that runtime. Fresh installs write `rin:web-search` unless the installer selection disables it.

### Browser and computer operation

Rin no longer includes bundled `rin:browser-use` or `rin:computer-use` aliases, packages, or default tools.

- Do not assume `browser_use` or `computer_use` exists unless it appears in the live tool list.
- Do not add old `rin:browser-use` or `rin:computer-use` aliases to `settings.json`.
- For browser automation patterns, read `practices/browser-use.md`.
- For desktop automation patterns, read `practices/computer-use.md`.
- If a user supplies a trusted third-party Pi extension for browser or computer control, configure it as a normal extension path/package under Pi's native extension rules, not as a Rin built-in alias.

## Background extensions

- disabled unless listed under `settings.json -> rinExtensions.backgroundServices` or a local/package extension exposes background capabilities
- run as trusted Node.js packages in Rin's background runtime for long-running async work
- may install or update configured npm packages under `~/.rin/data/extensions/runtime` during startup
- do not run in std/maintenance mode
- may register chat adapters with `ctx.registerChatAdapter(...)`
- may register external memory providers with `ctx.registerMemoryProvider(...)`; providers can implement `search`, `listRecent`, and `write`, and can return remote `reference` or `url` values instead of local transcript paths

Configure background services only when the user intentionally wants a background extension such as an external event bridge or a trusted memory backend. Keep the normal chat adapters under `settings.json -> chat`, not background services.
