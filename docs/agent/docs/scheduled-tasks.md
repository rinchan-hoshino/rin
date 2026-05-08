# Scheduled Tasks

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

Run now, pause, resume, complete, or delete:

```json
{ "id": "run_1", "type": "cron_run_task", "taskId": "cron_daily_brief" }
{ "id": "pause_1", "type": "cron_pause_task", "taskId": "cron_daily_brief" }
{ "id": "resume_1", "type": "cron_resume_task", "taskId": "cron_daily_brief" }
{ "id": "complete_1", "type": "cron_complete_task", "taskId": "cron_daily_brief", "reason": "completed_by_agent" }
{ "id": "delete_1", "type": "cron_delete_task", "taskId": "cron_daily_brief" }
```

`cron_run_task` manually starts the existing task record through the scheduler path, including built-in tasks; it does not clone the task or change its definition.

### Verification checklist

After changing tasks:

1. Re-read the task with `cron_get_task` or list tasks with `cron_list_tasks`.
2. Check `rin status --json` when liveness or next-run timing matters.
3. Confirm `enabled`, `nextRunAt`, `trigger`, `session.mode`, `thinkingLevel`, `target.kind`, and `chatKey` match the user's request.
4. For pause/delete/complete operations, verify progress stopped if there was an active run; status alone may show only scheduler state, not a spawned worker that already started.
