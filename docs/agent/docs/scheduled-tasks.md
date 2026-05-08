# Scheduled Tasks

Rin scheduled tasks are daemon-owned background jobs. Use them for reminders, delayed follow-ups, periodic checks, cron jobs, and recurring agent automation.

## Quick path

1. Identify the operation: create, inspect, update, run now, complete, pause, resume, or delete.
2. Use Rin scheduled tasks instead of systemd timers for user reminders and agent automation.
3. Use the local agent SDK for scheduled-task create, inspect, update, complete, delete, pause, resume, and run-now operations.
4. Use `rin status` or `rin status --json` for a redacted activity overview.
5. Do not construct raw daemon RPC payloads for normal task work.
6. After changing or starting a task, re-read daemon-visible state and verify the fields in the checklist below.

Read `~/.rin/docs/rin/docs/agent-sdk.md` for the shared SDK import snippet. In examples below, `rin` is the SDK instance returned by `createRinAgentSdk()`.

Do not edit `~/.rin/data/cron/tasks.json` while the daemon is running unless you are doing offline recovery; the running daemon is authoritative.

## Required verification

After changing tasks:

1. Re-read the task with `rin.tasks.get(taskId)` when it should still exist, or list tasks with `rin.tasks.list()` when it may be deleted.
2. Check `rin status --json` when liveness or next-run timing matters.
3. Confirm `enabled`, `nextRunAt`, `trigger`, `session.mode`, `thinkingLevel`, `target.kind`, and `chatKey` match the user's request.
4. For pause/delete/complete operations, verify progress stopped if there was an active run; status alone may show only scheduler state, not a spawned worker that already started.

## Task shape reference

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

## SDK operations

List tasks:

```js
const { tasks } = await rin.tasks.list();
```

Inspect one task:

```js
const { task } = await rin.tasks.get("cron_demo");
```

Create a one-time reminder:

```js
await rin.tasks.upsert({
  name: "Send reminder",
  enabled: true,
  thinkingLevel: "low",
  trigger: { runAt: "2026-05-08T13:30:00+08:00" },
  session: { mode: "none" },
  target: {
    kind: "agent_prompt",
    prompt: "Send the user a concise reminder: drink water.",
  },
});
```

Create a recurring agent task:

```js
await rin.tasks.upsert({
  id: "cron_daily_brief",
  name: "Daily brief",
  enabled: true,
  thinkingLevel: "medium",
  trigger: { expression: "30 8 * * *", timezone: "local" },
  session: { mode: "dedicated" },
  target: {
    kind: "agent_prompt",
    prompt:
      "Prepare today's brief using the current facts and send it to the configured chat.",
    continuationPrompt:
      "Prepare today's brief. Reuse prior task context only when it is still relevant.",
  },
});
```

Create a shell task:

```js
await rin.tasks.upsert({
  id: "cron_disk_check",
  name: "Disk check",
  enabled: true,
  trigger: { intervalMs: 3600000 },
  session: { mode: "none" },
  target: { kind: "shell_command", command: "df -h" },
});
```

Update an existing task:

Use `rin.tasks.upsert()` with the same `task.id`. Include the fields you intend to change; omitted fields reuse the existing task values.

```js
await rin.tasks.upsert({
  id: "cron_daily_brief",
  thinkingLevel: "low",
  target: {
    kind: "agent_prompt",
    prompt: "Prepare a shorter daily brief.",
    continuationPrompt: "Prepare a shorter daily brief.",
  },
});
```

Run now, pause, or resume a task:

```js
await rin.tasks.run("cron_daily_brief");
await rin.tasks.pause("cron_daily_brief");
await rin.tasks.resume("cron_daily_brief");
```

`rin.tasks.run()` manually starts the existing task record through the scheduler path, including built-in tasks; it does not clone the task or change its definition.

Complete or delete a task:

```js
await rin.tasks.complete("cron_daily_brief", "finished");
await rin.tasks.delete("cron_daily_brief");
```
