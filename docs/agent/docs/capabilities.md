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

## Scheduled tasks

Rin provides scheduled task support. As an agent, you should know that:

- you can create one-time, interval, and cron-style tasks
- it is suitable for reminders, periodic checks, delayed follow-ups, and background automation
- when a task should stop running without being removed, pause it; when it should be removed entirely, delete it

## Chat bridge

Rin can bridge chat platforms through a framework-neutral chat bridge layer. The direct built-in runtime currently includes Telegram, OneBot, QQ, Feishu / Lark, Discord, Slack, and Minecraft / QueQiao. As an agent, you should know that:

- the sender in a chat bridge conversation is not the local shell user; it is the chat-platform sender
- the prompt may include `chatKey`, chat name, sender identity, and related context
- chat rich content is written with Markdown, including native rich objects such as at, quote, image, file, video, audio, and sticker syntax
- native mentions require exact platform user ids; raw `@name` text is visible text only
- `chat_bridge` is the live bridge tool for advanced chat-platform operations and rich chat sending
- read `~/.rin/docs/rin/docs/chat-bridge.md` for runtime objects, examples, and adapter notes
- `/chat` is the TUI command for configuring the built-in official adapters
- `/chat` goes directly into platform selection in the TUI; the installer keeps the separate yes/no gate
- official adapter setup should prefer the minimum runnable fields, default to polling / socket modes when the adapter supports them, avoid webhook-only setup when possible, and include direct official links for required values

### Custom chat bridge adapters

The product-facing name is chat bridge. The internal runtime config key currently remains `settings.json -> chat` for compatibility.

If a user wants a custom chat bridge adapter that Rin does not ship as a built-in guided option, use the internal config shape below:

```json
{
  "chat": {
    "customAdapters": [
      {
        "packageName": "chat-plugin-adapter-example",
        "version": "latest",
        "pluginKey": "adapter-example",
        "config": {
          "token": "..."
        }
      }
    ]
  }
}
```

Notes for the agent:

- `packageName` is the npm package name
- `version` is optional and defaults to `latest`
- `pluginKey` is the internal adapter key for that package
- `config` can be a single config object, an array of named instances, or a keyed object map just like other adapter config blocks
- after editing `settings.json`, restart Rin; Rin will materialize the custom runtime package and install any missing custom adapter dependencies automatically before loading the bridge config
- treat custom adapters as trusted-code execution because they run as third-party Node.js code under the Rin user account

## Web search

Rin provides live web search. As an agent, you should know that:

- for latest, time-sensitive, version-sensitive, or potentially changed information, you should search proactively
- use fresh search results as the primary source for those questions, with memory as supporting context

## Direct URL fetch

Rin provides a `fetch` tool. As an agent, you should know that:

- use it when the user already gave you a specific URL and wants it read directly
- prefer it over `web_search` when discovery is not needed
- it returns readable text content rather than downloading files

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
- `rin usage` shows a simple text dashboard and supports grouped queries over the recorded dimensions

## Stable documentation paths

Rin installs docs into stable locations:

- `~/.rin/docs/rin/`: Rin-specific agent docs
- `~/.rin/docs/pi/`: installed copies of upstream Pi docs
- `~/.rin/docs/release/`: release-note metadata used by `/changelog`

Prefer these stable paths over specific `app/releases/<timestamp>/...` paths.
