# Builtin Capabilities

This document helps agents distinguish Rin core capabilities from optional Pi extensions. For general usage guidance, start with `docs/capabilities.md`; use this page when you need to know whether a tool is core, optional, or background-only.

## Quick reference

- Core Rin capabilities are available through native product code when their tools are present in the live tool list.
- The core todo capability is always enabled and registers the `todo` tool plus `/todos` command.
- Built-in optional extensions are packaged with Rin and are controlled through `settings.json -> extensions` with their `rin:` aliases.
- Fresh installs enable `rin:web-search` by default; existing installs keep their current settings until changed.
- Optional background services such as heartbeat notification remain off until `settings.json -> extensions` enables their `rin:` aliases.
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
- `subagent`
  - provides `run_subagent` and `list_models`
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

Rin ships optional web search, browser/computer control, and heartbeat notification as normal Pi extension packages under the installed app. They are "built in" in the packaging sense: the code is included with the Rin installation, while settings decide which entries are active.

Installed settings can use Rin aliases instead of installation-specific paths:

```json
{
  "extensions": ["rin:web-search", "rin:browser-use", "rin:computer-use"]
}
```

- `rin:web-search`
  - expands to the bundled `extensions/rin-web-search` Pi package
  - registers `web_search`
  - gets pages directly when `q` is an HTTP(S) URL
  - uses Rin-managed SearXNG for search queries; fresh install enables this alias and prepares the SearXNG runtime, while manual enablement prepares it best-effort
- `rin:browser-use`
  - expands to the bundled `extensions/rin-browser-use` Pi package
  - registers `browser_use`
  - always drives the external `agent-browser` CLI
  - reads optional configuration from `~/.rin/extensions/rin-browser-use.json`
  - otherwise works out of the box with `agent-browser` from `PATH`, then falls back to `npx -y agent-browser`
- `rin:computer-use`
  - expands to the bundled `extensions/rin-computer-use` Pi package
  - registers `computer_use`
  - reads optional configuration from `~/.rin/extensions/rin-computer-use.json`
  - otherwise works out of the box with platform backends: PowerShell/.NET on Windows, `screencapture` + `osascript`/`cliclick` on macOS, and screenshot tools + `xdotool` on Linux
  - may install `cliclick` through Homebrew only when `allowInstall` is `true` in the extension config file
- `rin:heartbeat-notifier`
  - expands to the bundled `extensions/rin-heartbeat-notifier` package
  - runs configurable record-only chat heartbeat agents as an in-process background extension
  - reads optional agent configuration from `~/.rin/extensions/rin-heartbeat-notifier.json`
  - uses bundled `agent-instructions.md` for reusable checklist/wake behavior; private deployment instructions stay in local files

Optional extension configuration uses Rin's extension-file convention. Rin does not create these files by default; create them only to override the open-box behavior.

```jsonc
// ~/.rin/extensions/rin-browser-use.json
{
  "command": "agent-browser",
  "args": [],
}
```

```jsonc
// ~/.rin/extensions/rin-computer-use.json
{
  "adapter": {
    "command": "my-computer-adapter",
    "args": [],
  },
  "allowInstall": false,
}
```

Use Pi resource filters with the alias to disable entries from a broader extension list:

```json
{
  "extensions": ["rin:browser-use", "rin:computer-use", "!rin:browser-use"]
}
```

If `extensions` is missing or `[]`, `todo` stays on by default and optional extension tools are off for that runtime. Fresh installs write `rin:web-search` unless the installer selection disables it.

### Optional heartbeat notification service

`rin:heartbeat-notifier` is a bundled background-capable extension, not core chat behavior. It owns reusable in-process heartbeat agents: no ordinary scheduled task is created or left on disk. The extension watches configured record-only chat message stores, appends new owner-message notifications into each agent's `state.attention`, sets `state.nextRunAt`, and starts the agent with a minimal round prompt.

Enable it through the normal bundled extension list:

```json
{
  "extensions": ["rin:heartbeat-notifier"]
}
```

Configure agents with Rin's extension-file convention:

```jsonc
// ~/.rin/extensions/rin-heartbeat-notifier.json
{
  "pollIntervalMs": 1000,
  "agents": [
    {
      "agentId": "owner_tg",
      "taskId": "heartbeat_owner_tg",
      "chatKey": "telegram/123456:7890",
      "privateInstructionPath": "/home/me/.rin-private/owner_tg.md",
    },
  ],
}
```

Keep the chat itself configured through core `chat.turnPolicy` as `record_only`; the optional extension is the notification bridge and reusable heartbeat-agent mind template. Heartbeat agents can use `state.attention`, `state.openLoops`, and `state.delegations` as memory abilities rather than a script. Due open delegations run as separate managed helper sessions. Put deployment-specific personality, names, and private preferences in `privateInstructionPath` or local state files, not in the reusable extension package.

### Enabling bundled browser/computer control

When a non-technical user asks to enable browser or computer control, edit their Rin `settings.json` rather than generating optional config files:

```json
{
  "extensions": ["rin:browser-use", "rin:computer-use"]
}
```

Keep the change minimal:

- preserve existing `extensions` entries and append the needed `rin:` aliases if absent
- do not create `~/.rin/extensions/rin-browser-use.json` or `~/.rin/extensions/rin-computer-use.json` unless the user needs a non-default command, adapter, timeout, or install policy
- for `browser_use`, prefer the default path: use `agent-browser` from `PATH`, otherwise let the extension invoke latest `agent-browser` through `npx -y agent-browser`
- for `computer_use`, inspect the host OS and install the smallest suitable native tool only when needed, such as `xdotool`/screenshot tools on Linux or `cliclick` on macOS; there is no adapter marketplace or curated adapter list to maintain
- after changing extension settings, restart or reload the Rin session/daemon as appropriate so Pi resources are reloaded

## Background extensions

- disabled unless listed under `settings.json -> rinExtensions.backgroundServices` or a local/package extension exposes background capabilities
- run as trusted Node.js packages in Rin's background runtime for long-running async work
- may install or update configured npm packages under `~/.rin/data/extensions/runtime` during startup
- do not run in std/maintenance mode
- may register chat adapters with `ctx.registerChatAdapter(...)`
- may register external memory providers with `ctx.registerMemoryProvider(...)`; providers can implement `search`, `listRecent`, and `write`, and can return remote `reference` or `url` values instead of local transcript paths

Configure background services only when the user intentionally wants a background extension such as an external event bridge or a trusted memory backend. Keep the normal chat adapters under `settings.json -> chat`, not background services.
