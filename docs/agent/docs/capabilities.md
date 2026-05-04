# Agent-facing Capabilities

This document summarizes only the capabilities and conventions an agent needs as a Rin user.

## Run modes

- `rin` normally prefers daemon + RPC TUI mode
- if the daemon goes offline temporarily, Rin tries to resume the interrupted session when it returns
- keep `rin` as the normal recommendation in guidance
- Rin automatically enters temporary maintenance mode only when the daemon is unavailable

## Self-update behavior

Rin installs a `rin` launcher for both the current installer user and the selected daemon target user when those accounts differ.

As an agent, use the `rin` command as the normal update entrypoint:

1. run `rin update`
2. if PATH does not include the launcher, run `~/.local/bin/rin update`
3. if the launcher is missing, treat that as an installation repair issue and audit the installed metadata described in `~/.rin/docs/rin/docs/runtime-layout.md`

Release-channel default:

- plain `rin update` targets the stable release channel
- `rin update --beta` targets the current weekly beta candidate
- `rin update --nightly` targets the current nightly build pinned from `main`
- `rin update --git` targets `main`
- `rin update --git <name>` targets that branch or ref directly
- `--branch` / `--version` remain supported as explicit selectors for direct stable/git resolution when needed

When `rin` is confirmed missing on an account that should have it, repair the launcher rather than teaching agents to find and execute runtime entry files manually. Use the target manifest or managed service files only for audit and repair.

Important implications:

- keep `rin update` as the canonical workflow for updating an installed Rin runtime
- reason in terms of installed runtime path, target user, launcher ownership, and permissions when repairing launcher state
- prefer the stable `app/current/` path only for read-only audit or emergency repair, not for normal agent-facing instructions
- treat `install.sh` as installation/bootstrap rather than the normal update path
- keep repo-checkout maintenance and installed-runtime maintenance as separate workflows; updating a repo checkout is not the same thing as updating the installed Rin runtime under `~/.rin/...`

## Memory and self-improve

Rin separates session history memory from self-improvement state. As an agent, you should know that:

- `search_memory` is for archived session history recall
- memory recall summarizes matched sessions with the active model at fixed `low` thinking
- always-on baselines live under `~/.rin/self_improve/prompts`
- agent-managed skills live under `~/.rin/self_improve/skills`
- not all self-improve content is injected into the prompt automatically
- before saving a new self-improve prompt, search first and avoid creating duplicates when possible
- reusable procedures, checklists, and operating playbooks belong in skills rather than prompts

## Non-interactive CLI

Use Pi-style `rin -p` or `rin --mode json` for isolated, scriptable one-shot agent turns from `bash`, including optional model/thinking selection and `--chat-key` delivery. Read `~/.rin/docs/rin/docs/non-interactive-cli.md` before building automation around it.

## Initialization mode

If the user asks to initialize Rin, restart initial setup, or set long-term assistant preferences, read this section and enter initialization mode.

In initialization mode, establish language first, collect durable assistant identity, user address preferences, and default voice/style preferences, then persist durable results with `save_prompts`.

## Scheduled tasks

Rin provides scheduled task support. As an agent, you should know that:

- you can create one-time, interval, and cron-style tasks through documented configuration or SDK workflows
- it is suitable for reminders, periodic checks, delayed follow-ups, and background automation
- use `task_control` only to pause or resume an existing task; create, update, delete, and inspect tasks through the documented workflow instead of a model tool

## Chat bridge

Rin can bridge chat platforms through a framework-neutral chat bridge layer. The direct built-in runtime currently includes Telegram, OneBot, QQ, Feishu / Lark, Discord, Slack, and Minecraft / QueQiao. As an agent, you should know that:

- the sender in a chat bridge conversation is not the local shell user; it is the chat-platform sender
- the prompt may include `chatKey`, chat name, sender identity, and related context
- chat rich content is written with Markdown, including native rich objects such as at, quote, image, file, video, audio, and sticker syntax
- native mentions require exact platform user ids; raw `@name` text is visible text only
- chat platform actions, stored-message lookup, log inspection, and identity updates are SDK/file workflows rather than model tools
- read `~/.rin/docs/rin/docs/chat-bridge.md` for SDK/runtime objects, examples, built-in adapter notes, and stored chat paths
- `/chat` is the TUI command for configuring the built-in official adapters
- `/chat` goes directly into platform selection in the TUI; the installer keeps the separate yes/no gate
- official adapter setup should prefer the minimum runnable fields, default to polling / socket modes when the adapter supports them, avoid webhook-only setup when possible, and include direct official links for required values

## Rin extension switches

Rin ships optional browser/computer control as normal Pi extension packages under the installed app. They are not core Rin capabilities; they are "built in" only because the installer includes their code. If `extensions` is missing or `[]`, both tools are off.

Example installed `settings.json`:

```json
{
  "extensions": ["rin:browser-use", "rin:computer-use"]
}
```

Optional bundled-extension configuration follows Rin's extension-file convention. Rin does not create these files by default; create them only when overriding the open-box behavior:

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

Notes for the agent:

- `rin:browser-use` registers `browser_use` and always drives the external `agent-browser` CLI; if no command is configured, it uses `agent-browser` from `PATH`, then falls back to the latest npm package through `npx -y agent-browser`
- `rin:computer-use` registers `computer_use`; if no adapter command is configured, it uses platform backends for Windows, Linux, or macOS
- use Pi resource filters with the Rin alias, for example `!rin:browser-use`, to disable a previously enabled bundled resource
- for non-technical users, enable the aliases in `settings.json` directly and avoid creating optional config files unless a non-default adapter, command, timeout, or install policy is actually required
- for `computer_use`, let the agent inspect the OS and install the smallest necessary native backend tool when needed; do not build or expect a curated adapter marketplace

Daemon worker extensions are configured separately because they are daemon-process background providers, not session tools:

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

- only configure trusted daemon worker package names and versions
- `daemonWorkers` are packages loaded by the daemon process for long-running async work; they are not Pi extensions and do not run in std mode
- daemon worker packages may be installed or updated with npm under `~/.rin/data/daemon-runtime` during daemon startup
- after editing `settings.json`, restart Rin so the daemon reloads daemon workers

## Web search

Rin provides live web search and direct URL fetching through `web_search`. As an agent, you should know that:

- for latest, time-sensitive, version-sensitive, or potentially changed information, you should search proactively
- use fresh search results as the primary source for those questions, with memory as supporting context
- when `q` is an HTTP(S) URL, `web_search` gets that page directly, uses a Chrome-like user agent, and extracts readable markdown/text from HTML with Readability-style extraction
- use URL mode when the user already gave you a specific URL and discovery is not needed

## Runtime activity status

Rin exposes live daemon activity for workers and scheduled tasks.

As an agent, you should know that:

- `rin status` prints a current worker and cron/scheduled-task snapshot
- `rin status --watch` refreshes the snapshot as a live terminal view
- `rin status --json` returns the raw `daemon_activity` RPC payload for custom frontends or external tooling
- RPC clients can call `daemon_activity` directly to get the same real-time worker and cron state without scraping terminal output
- `daemon_activity` includes a top-level `schemaVersion` and redacts scheduled task prompt/command bodies from the cron snapshot

## Token usage telemetry

Rin records detailed token telemetry for runtime events and assistant usage.

As an agent, you should know that:

- telemetry is stored under `~/.rin/data/token-usage/usage.db`
- it tracks session, event, model, source, tool, and capability metadata alongside token counts
- `rin usage` shows a charted text dashboard, current configured provider accounts/quotas when available, and grouped queries over the recorded dimensions

## Stable documentation paths

Rin installs docs into stable locations:

- `~/.rin/docs/rin/`: Rin-specific agent docs
- `~/.rin/docs/pi/`: installed copies of upstream Pi docs
- `~/.rin/docs/release/`: release-note metadata used by `/changelog`

Prefer these stable paths over specific `app/releases/<timestamp>/...` paths.
