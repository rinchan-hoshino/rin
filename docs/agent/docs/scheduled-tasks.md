# Scheduled Tasks

Rin scheduled tasks are daemon-owned background jobs. They are the default way to reduce human-in-the-loop load when work should happen later, repeatedly, conditionally, or after the current agent turn ends.

Use scheduled tasks for reminders, delayed follow-ups, periodic checks, cron jobs, recurring agent automation, run-now starts of saved jobs, and conditional background checks. Do not replace them with systemd timers, ad-hoc sleeps, hidden final-message promises, or manual “I will check later” claims.

## Agent decision rule

When a request contains any of these shapes, consider scheduled tasks before answering with a manual plan:

- **Time trigger:** “remind me”, “later”, “tomorrow”, “at 8:30”, “every morning”, “每小时/每天/每周”.
- **Polling/checking:** “keep an eye on it”, “check until”, “if it changes”, “有结果再告诉我”.
- **Recurring work:** daily briefings, health checks, cleanup passes, status reports, backups, account audits, quant reviews, release/watchdog checks.
- **Human-loop reduction:** anything that would otherwise require the owner to come back, ask again, or remember the next step.
- **Existing task operations:** inspect, update, pause, resume, complete, delete, reschedule, or run now.

If the desired time, chat target, authority, or irreversible action is unclear, ask only for that missing boundary. If the boundary is clear and safe, create or update the task and verify it.

## Read before operating

1. Read `~/.rin/docs/rin/docs/agent-sdk.md` for the SDK import and helper names.
2. Use the local Rin Agent SDK for normal task operations; do not construct raw `cron_*` daemon RPC payloads by hand.
3. Use `rin status` or `rin status --json` for a redacted liveness overview.
4. Do not edit `~/.rin/data/scheduler/tasks.json` while the daemon is running unless doing explicit offline recovery; the running daemon is authoritative.

## Operation workflow

1. Classify the operation: create, inspect, update, run now, reschedule one-time, pause, resume, complete, or delete.
2. Choose the smallest task shape that preserves the user-visible contract.
3. Use `rin.tasks.*` from the Agent SDK.
4. Re-read the task or list after the write.
5. When timing/liveness matters, check `rin status --json`.
6. Verify the fields below before reporting success.

Required verification after a create/update/run-state change:

- `id`, `name`, `enabled`, `completedAt`, `pausedAt`
- `trigger`, `nextRunAt`, and local-time expectation
- `condition` plus `condition.lastEvaluatedAt` / `condition.lastResult` after a run-now or due tick
- `session.mode`, `dedicatedSessionFile` when dedicated
- `target.kind`, prompt/command intent, `frontend`
- `model`, `thinkingLevel`
- `termination`, `runCount`, `lastStartedAt`, `lastFinishedAt`, `lastResultText`, `lastError`

For pause/delete/complete, also verify any active run stopped or no longer has a live producer; scheduler state alone may not prove a child turn has ended.

## Task record reference

A task record has these main fields. Some runtime fields are output-only and are filled by the scheduler.

```ts
type Task = {
  id?: string;
  name?: string;
  enabled?: boolean;
  // binds the task turn to a frontend/controller identity; use kind: "chat" for chat delivery
  frontend?: { kind?: string; key: string } | null;
  // controls whether the task final is posted to chat/frontends; default true
  deliverFinal?: boolean;
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  trigger: {
    // recurring cron trigger
    expression?: string;
    timezone?: "local";

    // one-time trigger; startAt is accepted as an input alias for runAt
    runAt?: string;
    startAt?: string;
  };
  termination?: { maxRuns?: number; stopAt?: string } | null;
  condition?: {
    code: string;
    timeoutMs?: number;
    lastEvaluatedAt?: string;
    lastResult?: boolean;
    lastOutput?: string;
  } | null;
  session?:
    | { mode: "none" | "dedicated" }
    | { mode: "session_instruction"; sessionFile: string };
  target:
    | { kind: "agent_prompt"; prompt: string; continuationPrompt?: string }
    | { kind: "shell_command"; command: string };

  // output-only lifecycle state
  createdAt?: string;
  updatedAt?: string;
  nextRunAt?: string;
  completedAt?: string;
  completionReason?: string;
  pausedAt?: string;
  runCount?: number;
  running?: boolean;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastResultText?: string;
  lastError?: string;
  dedicatedSessionFile?: string;
};
```

## Triggers

### One-time trigger

Use `trigger.runAt` with an ISO timestamp. `startAt` is accepted as an input alias and is normalized to `runAt`.

```js
const trigger = { runAt: "2026-05-08T13:30:00+08:00" };
```

One-time tasks complete after their first target execution. If a one-time task is skipped by a false condition, Rin marks it completed with `completionReason: "condition_false"`.

### Recurring trigger

Use a standard five-field cron expression evaluated in Rin local time. Include `timezone: "local"` for clarity.

```js
const trigger = { expression: "30 8 * * *", timezone: "local" };
```

Recurring tasks schedule the next tick after run-now, normal execution, or a false condition.

## Termination

Use `termination` to let a recurring task stop itself without a later manual cleanup.

```js
termination: { maxRuns: 7, stopAt: "2026-06-01T00:00:00+08:00" }
```

- `maxRuns` is clamped to at least `1` and completes the task when `runCount` reaches it.
- `stopAt` is normalized as an ISO timestamp and completes the task after that time.
- Set `termination: null` in `upsert()` to remove an existing termination rule.

## Conditional execution

Use `condition` when the schedule should wake only if agent-authored TypeScript returns true. This is the main tool for reducing unnecessary model turns.

When the condition returns false:

- Rin records `condition.lastEvaluatedAt`, `condition.lastResult: false`, and `condition.lastOutput`.
- The target does not run.
- `runCount` does not increase.
- A recurring task schedules the next tick.
- A one-time task completes as `condition_false`.

The condition runs in a short-lived Node process. Code may be:

- a TypeScript expression: `context.task.runCount === 0`
- a function body with `return`: `return context.task.runCount === 0`
- a function or async function value: `async (context) => true`

Context shape:

```ts
type ConditionContext = {
  now: string;
  task: {
    id: string;
    name?: string;
    runCount: number;
    lastStartedAt?: string;
    lastFinishedAt?: string;
    lastResultText?: string;
    lastError?: string;
    nextRunAt?: string;
  };
};
```

Timeout defaults to 5000 ms and is clamped to 100–60000 ms.

Example:

```js
await rin.tasks.upsert({
  id: "cron_watch_until_clean",
  name: "Watch until check passes",
  enabled: true,
  trigger: { expression: "*/30 * * * *", timezone: "local" },
  condition: {
    code: "return context.task.runCount === 0 || Boolean(context.task.lastError)",
    timeoutMs: 5000,
  },
  session: { mode: "none" },
  target: {
    kind: "agent_prompt",
    prompt:
      "Run the documented check. Report only if action is needed or fixed.",
  },
});
```

Set `condition: null` to remove an existing condition.

## Sessions

### `session.mode: "none"`

Default and preferred for independent reminders, simple checks, shell diagnostics, and polished chat reports that do not need cross-run memory.

Behavior:

- Agent tasks run in a managed task session for that run.
- Rin disposes/shuts down the no-session turn after completion, except special self-improve maintenance tasks.
- If `frontend` is set, Rin binds the scheduled turn to that frontend/controller identity.
- If `frontend.kind` is `"chat"`, the final task result is sent to that chat and may preserve a chat-bound session file for quote/resume context.
- Set root `deliverFinal: false` to bind the turn to that frontend without automatically displaying the task final; the agent can explicitly send a message through the SDK when useful.

### `session.mode: "dedicated"`

Use only when future runs need prior task context. Rin derives the session path from the task id:

```text
~/.rin/sessions/managed/task/<task-id>.jsonl
```

Behavior:

- First run uses `target.prompt`.
- Later runs use `target.continuationPrompt` when provided; otherwise they reuse `target.prompt`.
- The dedicated session persists across runs.

Avoid dedicated sessions for routine reports unless the task truly benefits from history; stale context can add noise.

### `session.mode: "session_instruction"`

Use for a follow-up inserted into an existing chat session. It can be one-time or recurring.

Requirements enforced by the scheduler:

- `target.kind` must be `"agent_prompt"`.
- Do not set `frontend`; Rin derives the existing frontend/chat binding from the stored session file.
- `session.sessionFile` must point to an existing stored session with a chat binding.
- Set root `deliverFinal: false` when the inserted turn should update the session without automatically posting its final text to chat.

Rin inserts the follow-up into the existing session without scheduled-task prompt-context injection.

## Targets and delivery

### `target.kind: "agent_prompt"`

Runs an agent turn. Use this for owner-facing reports, summaries, checks that need reasoning, and any task that should produce polished chat text.

- `frontend` binds execution to a frontend/controller identity.
- `frontend: { kind: "chat", key: "..." }` binds delivery to a chat bridge target.
- Set root `deliverFinal: false` to bind the turn without automatically sending the final task text.
- `model` and `thinkingLevel` override the run when present.
- Rin stores a summarized final result in `lastResultText`.
- If the agent turn has no canonical final assistant text, the task records `lastError`.

### `target.kind: "shell_command"`

Runs a shell command from the Rin user home directory using configured shell, `/bin/bash`, PATH `bash`, or `sh` fallback.

Use this for machine-style diagnostics and stable scripts. If the owner expects a polished report, prefer an `agent_prompt` task that runs the script and summarizes the result, because shell delivery includes machine fields like `Command`, `Exit`, `stdout`, and `stderr`.

Shell stdout/stderr are summarized before storage/delivery.

## SDK operations

Import the SDK as shown in `agent-sdk.md`; examples below assume `const rin = createRinAgentSdk()`.

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
  id: "cron_drink_water_once",
  name: "Send water reminder",
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

Create a recurring chat report:

```js
await rin.tasks.upsert({
  id: "cron_daily_brief",
  name: "Daily brief",
  enabled: true,
  frontend: { kind: "chat", key: "telegram/123456:7890" },
  thinkingLevel: "medium",
  trigger: { expression: "30 8 * * *", timezone: "local" },
  session: { mode: "none" },
  target: {
    kind: "agent_prompt",
    prompt:
      "Prepare today's brief using fresh facts. Send only the concise brief.",
  },
});
```

Create a dedicated recurring task:

```js
await rin.tasks.upsert({
  id: "cron_weekly_watch",
  name: "Weekly watch with memory",
  enabled: true,
  trigger: { expression: "0 9 * * 1", timezone: "local" },
  session: { mode: "dedicated" },
  target: {
    kind: "agent_prompt",
    prompt: "Start the weekly watch ledger and report the first status.",
    continuationPrompt:
      "Continue the weekly watch ledger. Report only meaningful changes.",
  },
});
```

Create a current-session follow-up:

```js
await rin.tasks.upsert({
  id: "cron_follow_up_here",
  name: "Follow up in this chat",
  enabled: true,
  trigger: { runAt: "2026-05-08T15:00:00+08:00" },
  session: {
    mode: "session_instruction",
    sessionFile: "/home/rin/.rin/sessions/managed/chat/example.jsonl",
  },
  target: {
    kind: "agent_prompt",
    prompt:
      "Continue this chat session and ask whether the pending review is done.",
  },
});
```

Create a shell task:

```js
await rin.tasks.upsert({
  id: "cron_disk_check",
  name: "Disk check",
  enabled: true,
  trigger: { expression: "0 * * * *", timezone: "local" },
  session: { mode: "none" },
  target: { kind: "shell_command", command: "df -h" },
});
```

Update an existing task:

```js
await rin.tasks.upsert({
  id: "cron_daily_brief",
  thinkingLevel: "low",
  condition: null,
  target: {
    kind: "agent_prompt",
    prompt: "Prepare a shorter daily brief.",
  },
});
```

`upsert()` merges with the existing task when `id` matches. Include fields you intend to change. Use `null` only for fields that explicitly support removal (`frontend`, `termination`, `condition`).

Run now, pause, or resume:

```js
await rin.tasks.run("cron_daily_brief");
await rin.tasks.wake("cron_daily_brief");
await rin.tasks.pause("cron_daily_brief");
await rin.tasks.resume("cron_daily_brief");
```

`rin.tasks.run()` starts the existing task record through the scheduler path. It does not clone the task or change its definition. It still evaluates `condition`.

`rin.tasks.wake()` only moves the existing task's next run time to now. The scheduler tick then evaluates `condition` normally. Use it for event notifications that should behave like a timer nudge rather than a forced run.

Set the next run time for any task:

```js
await rin.tasks.rescheduleOnce(
  "cron_follow_up_here",
  "2026-05-08T15:00:00+08:00",
);
```

`rescheduleOnce()` sets `nextRunAt`, clears `completedAt` / `completionReason` / `pausedAt`, and enables the task. For one-time tasks it also updates `trigger.runAt`; for recurring tasks it leaves the cron expression unchanged, so the agent can choose the next wake time without losing the normal recurrence.

Complete or delete:

```js
await rin.tasks.complete("cron_daily_brief", "finished");
await rin.tasks.delete("cron_daily_brief");
```

- `complete()` keeps a completed record with `completionReason` and disables future runs.
- `delete()` removes the record.
- Both terminate the task's active frontend turn when applicable.

## Built-in tasks

Rin installs some daemon-owned built-in tasks, such as daily memory-index repair and self-improve sleep consolidation. Built-in task definitions are protected from mutation/deletion by normal task APIs. `rin status --json` exposes built-in counts and redacted scheduler state; normal SDK list/get focuses on agent-created tasks.

Do not recreate a built-in task as an agent task. If a built-in seems broken, diagnose the daemon/source boundary.

## Design patterns

### Prefer automation over future promises

Bad:

```text
I will check this tomorrow.
```

Good:

```text
Created cron_follow_up_here for 2026-05-08 15:00 local time and verified nextRunAt.
```

### Prefer `agent_prompt` for user-facing reports

Use `shell_command` when raw machine output is acceptable. Use `agent_prompt` when the final recipient should receive a short domain summary.

### Prefer `condition` for cheap gates

If a task only needs a model when an external state changes, put the cheap state test in `condition` or in a lightweight script called by an `agent_prompt` task. This prevents empty periodic model turns.

### Prefer `session.mode: "none"` unless continuity is required

Dedicated sessions are powerful but add persistent context. Use them only when the task's next run really needs the previous run's reasoning or ledger.

### Give tasks stable, descriptive ids

Use ids like `cron_daily_brief`, `cron_qmt_evening_review`, or `cron_follow_up_here`. Avoid random ids unless the task is truly disposable.

## Troubleshooting

- Task did not run: inspect `enabled`, `completedAt`, `pausedAt`, `nextRunAt`, `condition.lastResult`, `lastError`, and `rin status --json`.
- Run-now returned but no report arrived: inspect `running`, `lastStartedAt`, active frontend turn, `lastError`, and the target `frontend`.
- Recurring task is noisy: add `condition`, lower `thinkingLevel`, or change prompt to report only changes.
- Report formatting is too raw: replace `shell_command` delivery with an `agent_prompt` wrapper.
- Current-session follow-up fails: verify the `sessionFile` exists and has a stored chat binding; do not add `frontend` to `session_instruction` tasks.
