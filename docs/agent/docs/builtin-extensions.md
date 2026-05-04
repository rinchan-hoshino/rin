# Builtin Capabilities

This document describes the extra capabilities Rin gives the agent.
Most of these capabilities are registered directly by Rin core rather than being force-loaded through the app layer as builtin extensions.

## Default extra capabilities

- `web-search`
  - provides live web search
  - gets web pages directly when `q` is an HTTP(S) URL
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
  - provides `task_control` for pausing or resuming existing scheduled tasks
  - task creation, updates, deletion, and inspection are documented workflows rather than agent tools
- `chat`
  - provides `/chat` for official adapter setup inside the TUI
  - chat sending, stored-message lookup, log inspection, and identity updates are documented SDK/file workflows rather than agent tools
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

### Agent guidance for enabling bundled browser/computer control

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
- for `computer_use`, let the agent inspect the host OS and install the smallest suitable native tool only when needed, such as `xdotool`/screenshot tools on Linux or `cliclick` on macOS; there is no adapter marketplace or curated adapter list to maintain
- after changing extension settings, restart or reload the Rin session/daemon as appropriate so Pi resources are reloaded

## Daemon worker extensions

- disabled unless listed under `settings.json -> rinExtensions.daemonWorkers`
- run as trusted Node.js packages inside the daemon process for long-running async work
- may install or update configured npm packages under `~/.rin/data/daemon-runtime` during daemon startup
- do not run in std/maintenance mode

## Usage note

Default capabilities are core Rin functions.
They live in their owning product domains such as `src/core/chat/`, `src/core/memory/`, `src/core/self-improve/`, `src/core/rin-lib/`, `src/core/chat-bridge/`, and `src/core/rin-tui/`; they are assembled by native product code, not by a generic extension runtime.

The optional browser/computer tools are different: they live under `extensions/` as external Pi extension packages and are loaded by Pi's extension runtime only when enabled.
