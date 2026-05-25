# Agent-facing Capabilities

Use this page as a quick entrypoint for Rin runtime capabilities. Follow the system prompt for standing identity, doctrine, and response style; this document only describes runtime facts and where to read next.

## Quick reference

- **Run Rin:** recommend `rin`. It normally uses daemon + RPC TUI mode and falls back to temporary maintenance mode only when the daemon is unavailable.
- **Update Rin:** use `rin update --yes` for non-interactive automation, or `rin update` when a human can confirm the plan. If PATH is missing the launcher, try `~/.local/bin/rin update --yes`; if the launcher is absent, repair the installation instead of running release files directly.
- **Rollback:** use `rin rollback`; missing `previousRelease` metadata is a repair problem, not a reason to guess from old symlinks.
- **Memory:** prompt baselines stay compact; reusable procedures and facts belong in skills; archived sessions are searched with `search_memory`. Read `docs/memory-layering.md` before changing memory content.
- **Non-interactive work:** use `rin -p` or `rin --mode json` only after reading `docs/non-interactive-cli.md`.
- **Initialization:** if the user asks to initialize or reset preferences, read `docs/initialization.md`.
- **Scheduled tasks:** use Rin scheduled tasks, not systemd timers, for reminders, delayed follow-ups, periodic checks, cron jobs, manual run-now starts, recurring agent automation, and conditional periodic checks. Scheduled tasks can include agent-authored TypeScript `condition` code; when it returns false, Rin skips the target and schedules the next tick. Read `~/.rin/docs/rin/docs/agent-sdk.md` and `~/.rin/docs/rin/docs/scheduled-tasks.md` before creating, inspecting, updating, running, completing, pausing, resuming, deleting, or configuring conditional execution.
- **Chat bridge:** chat sender identity comes from the platform, not the shell user. Read `docs/chat-bridge.md` for SDK/file workflows and adapter behavior; read `docs/rich-text-output-format.md` for native output objects.
- **Todo:** the core todo capability is always enabled; it registers the `todo` tool and `/todos` command.
- **Optional browser/computer tools:** disabled unless `settings.json -> extensions` includes `rin:browser-use` or `rin:computer-use`.
- **Web search:** use `web_search` proactively for fresh or version-sensitive facts; direct URL mode fetches a known page.
- **Status and usage:** use `rin status` / `rin status --json` for daemon activity and `rin usage` for token telemetry.
- **Stable docs:** prefer `~/.rin/docs/rin/`, `~/.rin/docs/pi/`, and `~/.rin/docs/release/` over versioned release paths.

## Update and rollback details

Rin installs a `rin` launcher for both the installer user and the selected daemon target user when those accounts differ. Keep `rin update` as the normal update entrypoint:

1. Run `rin update --yes` for non-interactive automation, or `rin update` when a human can confirm the plan.
2. If PATH does not include the launcher, run `~/.local/bin/rin update --yes` for non-interactive automation.
3. If the launcher is missing, audit the installed metadata in `docs/runtime-layout.md` and repair the launcher.

Release-channel defaults:

- `rin update`: stable release channel
- `rin update --beta`: current weekly beta candidate
- `rin update --nightly`: current nightly build pinned from `main`
- `rin update --git`: `main`
- `rin update --git <name>`: named branch or ref
- `--branch` / `--version`: explicit stable/git selectors when needed
- `--yes`: skips the final update confirmation prompt; use it only after the target user and install directory are known

`rin rollback` switches to the `previousRelease` recorded in `installer.json`, updates the manifest so another rollback can switch back, and restarts the daemon. If no `previousRelease` is recorded, treat that as missing rollback metadata instead of guessing from ad-hoc `current.old` files.

Keep installed-runtime maintenance separate from repo-checkout maintenance. Updating a source checkout is not the same as updating the installed runtime under `~/.rin/`.

## Memory and self-improve details

- Always-on baselines live under `~/.rin/self_improve/prompts` and should stay compact.
- Agent-managed skills live under `~/.rin/self_improve/skills` and should hold reusable procedures, playbooks, examples, domain facts, and compact indexes.
- `search_memory` recalls archived session history when original wording, evidence, or cross-session continuity matters.
- Memory recall summarizes matched sessions with the active model at fixed `low` thinking.
- Periodic memory review runs every `selfImprove.reviewEveryTurns` real agent final messages and defaults to `5`; review also runs on real session shutdown. Idle daemon worker sleep is not session shutdown and does not trigger shutdown memory maintenance.
- A hidden built-in nightly task performs sleep-style self-improve consolidation.
- Not all self-improve content is injected into the prompt automatically.

## Chat bridge details

Rin's direct built-in chat bridge currently includes Telegram, OneBot, QQ, Feishu / Lark, Discord, Slack, and Minecraft / QueQiao.

Key points for agents:

- The prompt may include `chatKey`, chat name, sender identity, and related context.
- Rich text output format lives in `docs/rich-text-output-format.md`; use it for native mentions, quotes, attachments, and fallback behavior.
- Chat sending, stored-message lookup, log inspection, and identity updates are SDK/file workflows rather than model tools.
- `/chat` configures official adapters in the TUI and enters platform selection directly.
- Official adapter setup should use the minimum runnable fields, prefer polling/socket modes when supported, avoid webhook-only setup when possible, and include direct official links for required values.

## Core todo and bundled Pi extensions

Rin always enables the core todo capability. It registers the `todo` tool for branch-aware checklists and `/todos` for the interactive TUI view directly from core code. It stays enabled even when optional Pi extensions are disabled.

In daemon/RPC chat turns, Rin can withhold a premature final answer when the todo list still contains incomplete items and continue hidden work automatically. Hidden continuations stop when todos complete, when the todo state does not change between continuations, or after 64 continuations.

Rin also ships optional browser/computer control as normal Pi extension packages under the installed app. They are packaged with Rin but stay off until enabled:

```json
{
  "extensions": ["rin:browser-use", "rin:computer-use"]
}
```

Optional config files are only for non-default behavior:

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

Notes:

- Core todo registers `todo` from core code and is always on.
- `rin:browser-use` registers `browser_use`, drives the external `agent-browser` CLI, uses `agent-browser` from PATH by default, then falls back to `npx -y agent-browser`.
- `rin:computer-use` registers `computer_use` and uses platform backends for Windows, Linux, or macOS by default.
- Use Pi resource filters such as `!rin:browser-use` to disable a previously enabled bundled resource.
- For non-technical users, edit `settings.json` directly and avoid optional config files unless a non-default command, adapter, timeout, or install policy is required.
- After changing extension settings, restart or reload Rin so resources are reloaded.

## Background extensions

Background extensions are configured under `settings.json -> rinExtensions.backgroundServices`, or discovered from normal Rin/Pi extension entries that expose background capabilities. They are trusted Node.js packages loaded by Rin's background runtime for long-running async work. They are a Rin extension capability layer, not a separate extension type that extension authors need to target.

```json
{
  "rinExtensions": {
    "backgroundServices": [
      {
        "name": "example-service",
        "packageName": "rin-background-service-example",
        "version": "latest",
        "config": {}
      }
    ]
  }
}
```

Use only trusted package names and versions. Packages may be installed or updated under `~/.rin/data/extensions/runtime` during startup; restart Rin after editing background extension settings.

## Web search details

Use fresh web search for latest, time-sensitive, version-sensitive, or otherwise changeable information. When `q` is an HTTP(S) URL, `web_search` fetches that page directly with a browser-like user agent and extracts readable content.

Default web search uses a Rin-managed local SearXNG sidecar so users can search without provider API keys, external search setup, or a Rin-managed search service. The installer prepares the SearXNG runtime; the daemon starts and keeps the sidecar warm; web-search calls use an already-running sidecar and never install SearXNG. The sidecar runs on loopback, stores its runtime, state, and generated settings under Rin's own `data/sidecars/web-search` directory, and does not write into the user's project files.

## Runtime status and token usage

- `rin status`: current worker and scheduled-task snapshot
- `rin status --watch`: live refreshing view
- `rin status --json`: raw `daemon_activity` RPC payload
- RPC clients can call `daemon_activity` directly for the same real-time state
- `daemon_activity` includes a top-level `schemaVersion` and redacts scheduled task prompt/command bodies
- Token telemetry is stored under `~/.rin/data/core/usage/usage.db`
- `rin usage` shows a text dashboard, configured provider account/quota data when available, and grouped usage queries

## Stable documentation paths

- `~/.rin/docs/rin/`: Rin-specific agent docs
- `~/.rin/docs/pi/`: installed upstream Pi docs
- `~/.rin/docs/release/`: release-note metadata used by `/changelog`
