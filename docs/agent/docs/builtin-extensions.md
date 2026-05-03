# Builtin Capabilities

This document describes the extra capabilities Rin gives the agent.
Most of these capabilities are registered directly by Rin core rather than being force-loaded through the app layer as builtin extensions.

## Default extra capabilities

- `web-search`
  - provides live web search
- `fetch`
  - provides direct URL text fetching
- `memory`
  - provides `*_memory` tools and memory-related prompt support
- `reset-system-prompt`
  - adds Rin's default stance and chat style prefix to the agent
- `message-header`
  - adds message metadata such as `sent at`; adds chat-specific context in chat bridge scenarios
- `freeze-session-runtime`
  - keeps the effective system prompt stable within a session
- `tui-input-compat`
  - smooths over some TUI input compatibility issues
- `task`
  - provides task management tools such as `list_tasks`, `save_task`, and `pause_task`
- `chat`
  - provides `chat_bridge`, `get_chat_msg`, `list_chat_log`, and `save_chat_user_identity`
  - provides `/chat` for official adapter setup inside the TUI
  - `/chat` enters platform selection directly, keeps installer-only opt-in confirmation, prefers the minimum runnable fields, defaults to polling / socket modes when supported, and includes direct official links for required values
- `token-usage`
  - records detailed token telemetry under `~/.rin/data/token-usage/usage.db`
  - powers the charted `rin usage` text dashboard, grouped usage queries, and best-effort configured provider account/quota display

## Bundled optional Pi extensions

Rin ships optional browser/computer control as normal Pi extension packages under the installed app, not as core Rin capabilities. They are "built in" only in the packaging sense: the code is included with the Rin installation, but the tools stay off until the user enables those extension resources.

Installed settings can use Rin aliases instead of installation-specific paths:

```json
{
  "extensions": ["rin:browser-use", "rin:computer-use"]
}
```

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

If `extensions` is missing or `[]`, both optional tools are off.

## Daemon worker extensions

- disabled unless listed under `settings.json -> rinExtensions.daemonWorkers`
- run as trusted Node.js packages inside the daemon process for long-running async work
- may install or update configured npm packages under `~/.rin/data/daemon-runtime` during daemon startup
- do not run in std/maintenance mode

## Usage note

Default capabilities are core Rin functions.
They live in their owning product domains such as `src/core/chat/`, `src/core/memory/`, `src/core/self-improve/`, `src/core/rin-lib/`, `src/core/chat-bridge/`, and `src/core/rin-tui/`; they are assembled by native product code, not by a generic extension runtime.

The optional browser/computer tools are different: they live under `extensions/` as external Pi extension packages and are loaded by Pi's extension runtime only when enabled.
