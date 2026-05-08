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

1. run `rin update --yes` for non-interactive automation, or `rin update` when a human can confirm the plan
2. if PATH does not include the launcher, run `~/.local/bin/rin update --yes` for non-interactive automation
3. if the launcher is missing, treat that as an installation repair issue and audit the installed metadata described in `~/.rin/docs/rin/docs/runtime-layout.md`

Release-channel default:

- plain `rin update` targets the stable release channel
- `rin update --beta` targets the current weekly beta candidate
- `rin update --nightly` targets the current nightly build pinned from `main`
- `rin update --git` targets `main`
- `rin update --git <name>` targets that branch or ref directly
- `--branch` / `--version` remain supported as explicit selectors for direct stable/git resolution when needed
- `--yes` skips the final update confirmation prompt; use it only after the target user and install directory are known

Rollback entrypoint:

- `rin rollback` switches the installed runtime to the `previousRelease` recorded in `installer.json`, updates the manifest so another rollback can switch back, and restarts the daemon.
- If no `previousRelease` is recorded, treat that as missing rollback metadata instead of guessing from ad-hoc `current.old` files.

When `rin` is confirmed missing on an account that should have it, repair the launcher rather than teaching agents to find and execute runtime entry files manually. Use the target manifest or managed service files only for audit and repair.

Important implications:

- keep `rin update` as the canonical workflow for updating an installed Rin runtime
- reason in terms of installed runtime path, target user, launcher ownership, and permissions when repairing launcher state
- prefer the stable `app/current/` path only for read-only audit or emergency repair, not for normal agent-facing instructions
- treat `install.sh` as installation/bootstrap rather than the normal update path
- keep repo-checkout maintenance and installed-runtime maintenance as separate workflows; updating a repo checkout is not the same thing as updating the installed Rin runtime under `~/.rin/...`

## Memory and self-improve

Rin separates memory into always-on prompt baselines, skills, and transcript archives. As an agent, you should know that:

- always-on baselines live under `~/.rin/self_improve/prompts` and should stay compact
- prompt baselines focus on stable identity, user identity, and standing doctrine; durable facts and knowledge are consolidated through skills and transcript memory
- agent-managed skills live under `~/.rin/self_improve/skills` and should hold reusable procedures, checklists, examples, playbooks, knowledge, concepts, and compact memory indexes
- `search_memory` is for archived session history recall when original context, evidence, or cross-session continuity matters
- memory recall summarizes matched sessions with the active model at fixed `low` thinking
- periodic memory review runs every `selfImprove.reviewEveryTurns` real agent final messages and defaults to `8`; user steering inputs and assistant tool-call-only/interim messages do not count; review also runs before compaction and on session shutdown; a hidden built-in nightly task performs sleep-style self-improve consolidation
- not all self-improve content is injected into the prompt automatically
- read `docs/memory-layering.md` when deciding whether material belongs in prompt baselines, skills, transcript memory, or short-lived transient task state

## Non-interactive CLI

Use Pi-style `rin -p` or `rin --mode json` for isolated, scriptable one-shot agent turns from `bash`, including optional model/thinking selection and `--chat-key` delivery. Read `~/.rin/docs/rin/docs/non-interactive-cli.md` before building automation around it.

## Initialization mode

If the user asks to initialize Rin, restart initial setup, or set long-term assistant preferences, read `~/.rin/docs/rin/docs/initialization.md` and follow its guidance.

## Scheduled tasks

Rin scheduled tasks are daemon-owned background jobs. Use them when the user asks for a reminder, delayed follow-up, periodic check, cron job, or recurring agent automation.

### Workflow

- Use `rin status` or `rin status --json` for a redacted activity overview.
- Use daemon RPC for create, inspect, update, complete, pause, resume, or delete operations.
- Do not edit `~/.rin/data/cron/tasks.json` while the daemon is running unless you are doing offline recovery; the running daemon is authoritative.

### Task shape

A task record has these main fields:

```ts
type Task = {
  id?: string;
  name?: string;
  enabled?: boolean;
  chatKey?: string | null;
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  trigger: {
    runAt?: string;
    intervalMs?: number;
    startAt?: string;
    expression?: string;
    timezone?: "local";
  };
  termination?: { maxRuns?: number; stopAt?: string } | null;
  session?: { mode: "none" | "dedicated" };
  target:
    | { kind: "agent_prompt"; prompt: string; continuationPrompt?: string }
    | { kind: "shell_command"; command: string };
};
```

Trigger rules:

- one-time task: `trigger.runAt` as an ISO timestamp
- interval task: `trigger.intervalMs`, optionally `trigger.startAt`
- cron task: `trigger.expression` with five fields, evaluated in local time

Session rules:

- `session.mode: "none"` is default and best for reminders, shell checks, and independent prompts.
- `session.mode: "dedicated"` keeps a stable managed session under `~/.rin/sessions/managed/task/<task-id>.jsonl`; use it only when future runs need prior context.
- Dedicated agent tasks use `target.prompt` for the first run and `target.continuationPrompt` for later runs when provided.

Target rules:

- `agent_prompt` runs an agent turn. Set `thinkingLevel` explicitly: `low` for simple reminders/checks, `medium` for summaries, `high` only for difficult code/review/repair tasks.
- `shell_command` runs a shell command and stores summarized output.
- `chatKey` binds agent-task delivery to a chat bridge target when the task should reply there.

### Daemon RPC helper

When no first-party CLI subcommand exists for the needed mutation, send a JSON command to the daemon socket. This helper uses the same default socket path as Rin and respects `RIN_DAEMON_SOCKET_PATH`.

```sh
node <<'NODE'
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const runtimeDir =
  process.platform === "linux" && typeof process.getuid === "function"
    ? `/run/user/${process.getuid()}`
    : process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".cache");
const socketPath =
  process.env.RIN_DAEMON_SOCKET_PATH ||
  path.join(runtimeDir, "rin-daemon", "daemon.sock");
const command = {
  id: `cron_${Date.now()}`,
  type: "cron_list_tasks",
};

const socket = net.createConnection({ path: socketPath });
let buffer = "";
socket.on("data", (chunk) => {
  buffer += String(chunk);
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const payload = JSON.parse(line);
    if (payload.type === "response" && payload.id === command.id) {
      if (!payload.success) {
        throw new Error(payload.error || "daemon_request_failed");
      }
      console.log(JSON.stringify(payload.data, null, 2));
      socket.end();
    }
  }
});
socket.on("connect", () => socket.write(JSON.stringify(command) + "\n"));
socket.on("error", (error) => {
  throw error;
});
NODE
```

Change only the `command` object for the operation you need.

### RPC commands

List tasks:

```json
{ "id": "list_1", "type": "cron_list_tasks" }
```

Inspect one task:

```json
{ "id": "get_1", "type": "cron_get_task", "taskId": "cron_demo" }
```

Create a one-time reminder:

```json
{
  "id": "upsert_1",
  "type": "cron_upsert_task",
  "task": {
    "name": "Send reminder",
    "enabled": true,
    "thinkingLevel": "low",
    "trigger": { "runAt": "2026-05-08T13:30:00+08:00" },
    "session": { "mode": "none" },
    "target": {
      "kind": "agent_prompt",
      "prompt": "Send the user a concise reminder: drink water."
    }
  }
}
```

Create a recurring agent task:

```json
{
  "id": "upsert_2",
  "type": "cron_upsert_task",
  "task": {
    "id": "cron_daily_brief",
    "name": "Daily brief",
    "enabled": true,
    "thinkingLevel": "medium",
    "trigger": { "expression": "30 8 * * *", "timezone": "local" },
    "session": { "mode": "dedicated" },
    "target": {
      "kind": "agent_prompt",
      "prompt": "Prepare today's brief using the current facts and send it to the configured chat.",
      "continuationPrompt": "Prepare today's brief. Reuse prior task context only when it is still relevant."
    }
  }
}
```

Create a shell task:

```json
{
  "id": "upsert_3",
  "type": "cron_upsert_task",
  "task": {
    "id": "cron_disk_check",
    "name": "Disk check",
    "enabled": true,
    "trigger": { "intervalMs": 3600000 },
    "session": { "mode": "none" },
    "target": { "kind": "shell_command", "command": "df -h" }
  }
}
```

Update an existing task with `cron_upsert_task` and the same `task.id`. Include the fields you intend to change; omitted fields reuse the existing task values.

```json
{
  "id": "update_1",
  "type": "cron_upsert_task",
  "task": {
    "id": "cron_daily_brief",
    "thinkingLevel": "low",
    "target": {
      "kind": "agent_prompt",
      "prompt": "Prepare a shorter daily brief.",
      "continuationPrompt": "Prepare a shorter daily brief."
    }
  }
}
```

Pause, resume, complete, or delete:

```json
{ "id": "pause_1", "type": "cron_pause_task", "taskId": "cron_daily_brief" }
{ "id": "resume_1", "type": "cron_resume_task", "taskId": "cron_daily_brief" }
{ "id": "complete_1", "type": "cron_complete_task", "taskId": "cron_daily_brief", "reason": "completed_by_agent" }
{ "id": "delete_1", "type": "cron_delete_task", "taskId": "cron_daily_brief" }
```

### Verification checklist

After changing tasks:

1. Re-read the task with `cron_get_task` or list tasks with `cron_list_tasks`.
2. Check `rin status --json` when liveness or next-run timing matters.
3. Confirm `enabled`, `nextRunAt`, `trigger`, `session.mode`, `thinkingLevel`, `target.kind`, and `chatKey` match the user's request.
4. For pause/delete/complete operations, verify progress stopped if there was an active run; status alone may show only scheduler state, not a spawned worker that already started.

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

If search fails with `google_challenge_required` or `duckduckgo_challenge_required`, the upstream search engine returned an anti-bot/captcha page to the Rin runtime's network path. The user cannot clear that challenge by solving a captcha in their personal browser unless Rin is using the same browser/session/network. Practical recovery is to wait and retry with fewer repeated searches, change the runtime egress network/proxy/VPN or IP, fetch a known URL directly, or use a trusted search backend/API instead of the challenged direct engine.

SearXNG reduces this failure rate rather than magically bypassing challenges: it centralizes per-engine request shapes, rate limits, and optional proxy/instance rotation. Its Google engine uses a localized supported Google domain, `hl`/`lr`/`cr` locale parameters, `CONSENT=YES+`, `Accept: */*`, utf8 encoding, and a mobile Google-app-shaped user-agent so Google is more likely to return server-rendered results. Its DuckDuckGo engine uses the no-JS HTML form POST flow with browser navigation headers instead of a bare lite GET. If the upstream engine challenges the egress IP, the request must still back off, rotate the egress path, or report the challenge.

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
