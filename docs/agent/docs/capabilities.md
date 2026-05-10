# Agent-facing Capabilities

Use this page as a quick entrypoint for Rin runtime capabilities. Follow the system prompt for standing identity, doctrine, and response style; this document only describes runtime facts and where to read next.

## Quick reference

- **Run Rin:** recommend `rin`. It normally uses daemon + RPC TUI mode and falls back to temporary maintenance mode only when the daemon is unavailable.
- **Update Rin:** use `rin update --yes` for non-interactive automation, or `rin update` when a human can confirm the plan. If PATH is missing the launcher, try `~/.local/bin/rin update --yes`; if the launcher is absent, repair the installation instead of running release files directly.
- **Rollback:** use `rin rollback`; missing `previousRelease` metadata is a repair problem, not a reason to guess from old symlinks.
- **Memory:** prompt baselines stay compact; reusable procedures and facts belong in skills; archived sessions are searched with `search_memory`. Read `docs/memory-layering.md` before changing memory content.
- **Non-interactive work:** use `rin -p` or `rin --mode json` only after reading `docs/non-interactive-cli.md`.
- **Initialization:** if the user asks to initialize or reset preferences, read `docs/initialization.md`.
- **Scheduled tasks:** use Rin scheduled tasks, not systemd timers, for reminders, delayed follow-ups, periodic checks, cron jobs, manual run-now starts, and recurring agent automation. Read `~/.rin/docs/rin/docs/agent-sdk.md` and `~/.rin/docs/rin/docs/scheduled-tasks.md` before creating, inspecting, updating, running, completing, pausing, resuming, or deleting them.
- **Chat bridge:** chat sender identity comes from the platform, not the shell user. Read `docs/chat-bridge.md` for SDK/file workflows and rich content behavior.
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
- Periodic memory review runs every `selfImprove.reviewEveryTurns` real agent final messages and defaults to `8`; review also runs before compaction and on real session shutdown. Idle daemon worker sleep is not session shutdown and does not trigger shutdown memory maintenance.
- A hidden built-in nightly task performs sleep-style self-improve consolidation.
- Not all self-improve content is injected into the prompt automatically.

## Chat bridge details

Rin's direct built-in chat bridge currently includes Telegram, OneBot, QQ, Feishu / Lark, Discord, Slack, and Minecraft / QueQiao.

Key points for agents:

- The prompt may include `chatKey`, chat name, sender identity, and related context.
- Chat rich content uses Markdown extensions such as native mentions, quotes, images, files, video, audio, and stickers.
- Native mentions require exact platform user ids; raw `@name` text is plain visible text.
- Chat sending, stored-message lookup, log inspection, and identity updates are SDK/file workflows rather than model tools.
- `/chat` configures official adapters in the TUI and enters platform selection directly.
- Official adapter setup should use the minimum runnable fields, prefer polling/socket modes when supported, avoid webhook-only setup when possible, and include direct official links for required values.

## Optional bundled Pi extensions

Rin ships optional browser/computer control as normal Pi extension packages under the installed app. They are packaged with Rin but stay off until enabled:

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

- `rin:browser-use` registers `browser_use`, drives the external `agent-browser` CLI, uses `agent-browser` from PATH by default, then falls back to `npx -y agent-browser`.
- `rin:computer-use` registers `computer_use` and uses platform backends for Windows, Linux, or macOS by default.
- Use Pi resource filters such as `!rin:browser-use` to disable a previously enabled bundled resource.
- For non-technical users, edit `settings.json` directly and avoid optional config files unless a non-default command, adapter, timeout, or install policy is required.
- After changing extension settings, restart or reload Rin so resources are reloaded.

## Daemon worker extensions

Daemon worker extensions are configured under `settings.json -> rinExtensions.daemonWorkers`. They are trusted Node.js packages loaded by the daemon process for long-running async work. They are not Pi extensions and do not run in std mode.

```json
{
  "rinExtensions": {
    "daemonWorkers": [
      {
        "name": "example-worker",
        "packageName": "rin-daemon-worker-example",
        "version": "latest",
        "config": {}
      }
    ]
  }
}
```

Use only trusted package names and versions. Packages may be installed or updated under `~/.rin/data/daemon-runtime` during daemon startup; restart Rin after editing daemon worker settings.

## Web search details

Use fresh web search for latest, time-sensitive, version-sensitive, or otherwise changeable information. When `q` is an HTTP(S) URL, `web_search` fetches that page directly with a browser-like user agent and extracts readable content.

If search fails with `google_challenge_required` or `duckduckgo_challenge_required`, the upstream engine challenged the Rin runtime's network path. Practical recovery is to wait and retry with fewer repeated searches, change the runtime egress network/proxy/VPN or IP, fetch a known URL directly, or use a trusted search backend/API.

SearXNG reduces challenge frequency with engine-specific request shaping and rate limiting, but it does not bypass an upstream challenge on a blocked egress IP.

## Runtime status and token usage

- `rin status`: current worker and scheduled-task snapshot
- `rin status --watch`: live refreshing view
- `rin status --json`: raw `daemon_activity` RPC payload
- RPC clients can call `daemon_activity` directly for the same real-time state
- `daemon_activity` includes a top-level `schemaVersion` and redacts scheduled task prompt/command bodies
- Token telemetry is stored under `~/.rin/data/token-usage/usage.db`
- `rin usage` shows a text dashboard, configured provider account/quota data when available, and grouped usage queries

## Stable documentation paths

- `~/.rin/docs/rin/`: Rin-specific agent docs
- `~/.rin/docs/pi/`: installed upstream Pi docs
- `~/.rin/docs/release/`: release-note metadata used by `/changelog`
