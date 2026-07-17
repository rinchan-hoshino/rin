# Scheduled Tasks

Use scheduled tasks when work should happen after the current turn: future reminders, recurrence, polling, conditional checks, or background automation.

A scheduled task is an automation contract. Its record and target define the trigger, evidence source, allowed work, side effects, delivery target, stop condition, and verification required before reporting success.

## Prompt brief

Target surface:

- daemon-owned scheduler records in `~/.rin/data/scheduler/tasks.json`;
- Agent SDK `rin.tasks.*` helpers;
- CLI `rin tasks reload` for explicit daemon hot reload from the persisted task file;
- optional chat/frontend delivery through the chat bridge;
- optional shell commands or agent turns.

Goal:

- convert a future, recurring, conditional, or background request into a verified scheduler record and a task prompt that can run without extra human prompting.

Trusted inputs:

- the user's requested time, recurrence, target chat, task goal, and permission boundary;
- existing task record when updating an id;
- current daemon/scheduler state from SDK reads or `rin status --json`.

Output contract:

- task id and operation performed;
- trigger and expected next local run time;
- condition/session/target/delivery/termination choices;
- verification result after re-reading task state;
- active producer status when pausing, completing, deleting, or terminating work.

## Success criteria

A scheduled-task operation is complete when:

- the task record expresses the smallest correct contract for the request;
- file-based edits have been explicitly loaded with `rin tasks reload` or `rin.tasks.reload()`, then verified by daemon state;
- `target.prompt` or `target.command` expresses the intended work without hidden extra prompt insertion;
- `nextRunAt`, `enabled`, and lifecycle fields match the requested state;
- delivery settings match the intended recipient or intentionally suppress automatic delivery;
- recurring or polling tasks include a gate or report rule that controls duplicate work;
- follow-up state is stored in an explicit external surface when later runs need durable state.

## Request classification

Create or operate a task for:

- **future time:** reminders, later follow-up, one-time checks;
- **recurrence:** daily briefs, hourly checks, weekly reviews, regular audits;
- **polling/watch:** repeated checks until external state changes;
- **background automation:** health checks, release/watchdog checks, backup reviews, quant reviews, account audits, cleanup passes;
- **existing task control:** inspect, update, reload from disk, run now, wake, reschedule, pause, resume, complete, or delete.

When a single missing field changes the contract, ask for that field. Typical missing fields are exact time, target chat, action authority, or the event that should stop a watch task.

## Design contract

Choose the smallest task shape that preserves the user-visible contract:

1. **Operation:** create, inspect, update, reload from disk, run now, wake, reschedule, pause, resume, complete, or delete.
2. **Trigger:** one-time `runAt` or recurring cron `expression`.
3. **Condition gate:** optional TypeScript `condition` for cheap “only run if needed” checks.
4. **Target:** `agent_prompt` for reasoning or user-facing reports; `shell_command` for machine checks.
5. **Task prompt:** use `rin-prompt-engineering` for `target.prompt` and `target.continuationPrompt` on `agent_prompt` tasks.
6. **Storage/edit path:** SDK writes and CLI operations update daemon scheduler state and the same scheduler file. If `~/.rin/data/scheduler/tasks.json` is edited outside the daemon, run `rin tasks reload` or `rin.tasks.reload()` explicitly; the daemon does not watch the file automatically.
7. **Session:** `none` for normal tasks; `dedicated` for a task-owned continuing thread.
8. **Delivery:** optional addressable `frontend`, chat binding, `deliverFinal`, and `quiet`. A TUI is unaddressed and cannot be a task frontend binding.
9. **Termination:** optional `maxRuns` or `stopAt`.
10. **Verification:** re-read the task and check liveness when active producers matter.

## Task prompt contract

For `target.kind: "agent_prompt"`, write the prompt as a runnable task prompt. Use `rin-prompt-engineering` to define:

- source of truth and evidence to read;
- exact scope of work;
- allowed reads and writes;
- side effects that need a separate owner decision;
- retry budget and stop conditions;
- validation required before success;
- final report fields;
- recurring-task “no change” behavior;
- duplicate-work controls;
- evidence or state to leave behind.

For `target.continuationPrompt`, write the later-run contract, not a restatement of first-run setup.

## Required verification after a create/update/run-state change

Verify these fields before reporting success:

- `id`, `name`, `enabled`, `completedAt`, `pausedAt`;
- `trigger`, `nextRunAt`, and expected local time;
- `condition`, plus `condition.lastEvaluatedAt` / `condition.lastResult` after a run-now or due tick;
- `session.mode`, and `dedicatedSessionFile` for dedicated sessions;
- `target.kind`, prompt or command intent, `frontend`, `deliverFinal`, and `quiet`;
- `model`, `thinkingLevel`;
- `termination`, `runCount`, `lastStartedAt`, `lastFinishedAt`, `lastResultText`, `lastError`.

For pause, delete, complete, or terminate-like changes, verify active run state as well as scheduler record state.

## Task record reference

Main fields:

```ts
type Task = {
  id?: string;
  name?: string;
  enabled?: boolean;
  frontend?: { kind?: string; key: string } | null;
  deliverFinal?: boolean;
  quiet?: boolean;
  model?: string;
  thinkingLevel?:
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max";
  trigger: {
    expression?: string;
    timezone?: "local";
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
  session?: { mode: "none" | "dedicated" };
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

`upsert()` merges with an existing task when `id` matches. Include the fields you intend to change. Use `frontend: null`, `termination: null`, or `condition: null` to remove those optional fields. The daemon loads the persisted task file at startup and when explicitly requested through `rin tasks reload` or `rin.tasks.reload()`: valid JSON edits, additions, and removals take effect without restarting the daemon only after that reload command. Invalid JSON leaves the running daemon schedule unchanged and makes the reload fail, so a partial manual edit does not silently replace the in-memory schedule.

For agent-backed tasks, the scheduler owns the trigger and a durable invocation receipt, while the ordinary session/turn runtime remains authoritative for execution and terminal completion. The receipt snapshots the submitted prompt, session target, frontend policy, and stable turn identity before dispatch. After a daemon restart, Rin attaches to that same turn instead of submitting the prompt again. `running` and the `last*` fields are scheduler projections of this lifecycle; the internal receipt is intentionally omitted from task APIs.

## Trigger contract

### One-time trigger

Use `trigger.runAt` with an ISO timestamp. `startAt` is accepted as an input alias and normalizes to `runAt`.

```js
const trigger = { runAt: "2026-05-08T13:30:00+08:00" };
```

One-time tasks complete after their first target execution. A false condition completes the task with `completionReason: "condition_false"`.

### Recurring trigger

Use a standard five-field cron expression evaluated in Rin local time. Include `timezone: "local"` for clarity.

```js
const trigger = { expression: "30 8 * * *", timezone: "local" };
```

Recurring tasks schedule the next tick after a normal execution, run-now execution, or false condition.

## Condition contract

Use `condition` when the schedule should wake only if agent-authored TypeScript returns true. This is the main way to gate polling and periodic checks before a model turn.

When the condition returns false:

- Rin records `condition.lastEvaluatedAt`, `condition.lastResult: false`, and `condition.lastOutput`.
- The target stays idle.
- `runCount` keeps its previous value.
- A recurring task schedules the next tick.
- A one-time task completes as `condition_false`.

Condition code runs in a short-lived Node process. Code may be:

- a TypeScript expression: `context.task.runCount === 0`;
- a function body with `return`: `return context.task.runCount === 0`;
- a function or async function value: `async (context) => true`.

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
      "Read the documented check source. Run the check. If action is needed, fix within the approved boundary and report validation; if state is unchanged, record the unchanged evidence and finish without a chat alert.",
  },
});
```

Set `condition: null` in `upsert()` to remove an existing condition.

## Termination contract

Use `termination` when a recurring task should stop by itself.

```js
termination: { maxRuns: 7, stopAt: "2026-06-01T00:00:00+08:00" }
```

- `maxRuns` is clamped to at least `1` and completes the task when `runCount` reaches it.
- `stopAt` is normalized as an ISO timestamp and completes the task after that time.
- Set `termination: null` in `upsert()` to remove an existing termination rule.

## Session contract

Choose `session.mode` by where the scheduled agent turn should get conversational context. Store reliable facts, progress, ledgers, and decisions in an explicit external surface that each run can read.

### `session.mode: "none"`

Default for reminders, one-time tasks, periodic reports, checks, shell diagnostics, and workflows whose state is stored outside the agent session.

Use `none` for recurring work when each run can reconstruct context from the task prompt plus external state. Ordinary recurring tasks use external state instead of a dedicated session.

Behavior:

- Agent tasks run in a managed task session for that run.
- Rin disposes or shuts down the no-session turn after completion, except special self-improve distillation tasks.
- If an addressable `frontend` is set, Rin binds the scheduled turn to that frontend/controller identity.
- TUI frontends have no key and cannot be bound. Tasks created from a TUI omit `frontend` and run independently.
- If `frontend.kind` is `"chat"`, the final task result is sent to that chat and may preserve a chat-bound session file for quote/resume context.
- Root `deliverFinal: false` binds the turn while suppressing automatic final delivery; the agent may explicitly send through the SDK when useful.

### `session.mode: "dedicated"`

Use when the task is intentionally a task-owned agent thread. The clearest signal is a setup `target.prompt` plus a distinct `target.continuationPrompt` for later runs.

Rin derives the session path from the task id:

```text
~/.rin/sessions/managed/task/<task-id>.jsonl
```

Behavior:

- First run uses `target.prompt`.
- Later runs use `target.continuationPrompt` when provided; otherwise they reuse `target.prompt`.
- The dedicated session persists across runs.

Choose `dedicated` when the persistent conversation is part of the intended context, such as an intentionally guided recurring thread.

## Target and delivery contract

### `target.kind: "agent_prompt"`

Runs an agent turn. Use this for owner-facing reports, summaries, checks that need reasoning, and tasks that should produce polished chat text.

- An addressable `frontend` binds execution to a frontend/controller identity.
- `frontend: { kind: "chat", key: "..." }` binds delivery to a chat bridge target.
- TUI frontends are unaddressed and cannot be specified as task frontend bindings.
- Root `deliverFinal: false` binds the turn while suppressing automatic final delivery.
- Root `quiet` defaults to `true`. For chat-bound agent turns it has the same meaning as chat quiet mode: interim and passive-notice deliveries are suppressed, while independent errors remain visible and final delivery itself remains controlled by `deliverFinal`.
- `model` and `thinkingLevel` override the run when present.
- Rin stores a summarized final result in `lastResultText`.
- If the agent turn has no canonical final assistant text, the task records `lastError`.

### `target.kind: "shell_command"`

Runs a shell command from the Rin user's home directory using the configured shell, `/bin/bash`, PATH `bash`, or `sh` fallback.

Use this for machine-style diagnostics and stable scripts. If the recipient expects a domain summary, use an `agent_prompt` task that runs the script and summarizes the result. Shell delivery includes machine fields like `Command`, `Exit`, `stdout`, and `stderr`.

Shell stdout/stderr are summarized before storage and delivery.

## SDK operations

Import the SDK as shown in `agent-sdk.md`; examples below assume `const rin = createRinAgentSdk()`.

```js
const { tasks } = await rin.tasks.list();
const { task } = await rin.tasks.get("cron_demo");

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
      "Read the configured daily-brief sources. Summarize only confirmed changes and include the evidence timestamp for each item.",
  },
});

await rin.tasks.run("cron_daily_brief");
await rin.tasks.wake("cron_daily_brief");
await rin.tasks.rescheduleOnce("cron_daily_brief", "2026-05-08T15:00:00+08:00");
await rin.tasks.pause("cron_daily_brief");
await rin.tasks.resume("cron_daily_brief");
await rin.tasks.complete("cron_daily_brief", "finished");
await rin.tasks.delete("cron_daily_brief");
```

Operation meanings:

- `rin.tasks.list()` lists visible agent-created tasks.
- `rin.tasks.get(taskId)` reads one visible task.
- `rin.tasks.upsert(task, defaults?)` creates or updates the task with the matching id.
- `rin.tasks.run(taskId)` starts the existing task through scheduler semantics and still evaluates `condition`.
- `rin.tasks.wake(taskId)` moves the next run to now; the scheduler tick then evaluates the task normally.
- `rin.tasks.rescheduleOnce(taskId, runAt)` sets `nextRunAt`, clears completed/paused state, enables the task, updates one-time `trigger.runAt`, and preserves recurring cron expressions.
- `rin.tasks.pause(taskId)` disables future runs and asks Rin to stop applicable active task turns.
- `rin.tasks.resume(taskId)` enables the task and recomputes `nextRunAt`.
- `rin.tasks.complete(taskId, reason?)` disables future runs while keeping a completed record.
- `rin.tasks.delete(taskId)` removes the record.

## Examples

### One-time reminder

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

### Dedicated recurring thread

```js
await rin.tasks.upsert({
  id: "cron_guided_thread",
  name: "Guided recurring thread",
  enabled: true,
  trigger: { expression: "0 9 * * 1", timezone: "local" },
  session: { mode: "dedicated" },
  target: {
    kind: "agent_prompt",
    prompt:
      "Start this task's dedicated agent thread. State the objective once, run the first check, and report setup status.",
    continuationPrompt:
      "Continue this task's dedicated agent thread. Run the next check and report new findings, unchanged evidence, or blockers.",
  },
});
```

### Shell check

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

## Built-in tasks

Rin installs daemon-owned built-in tasks such as daily memory-index repair and self-improve sleep consolidation. Built-in task definitions are protected from normal mutation/deletion APIs.

Normal SDK `list()` and `get()` focus on agent-created visible tasks. Use `rin status --json` for built-in counts and redacted scheduler state.

## Final report contract

Report:

- task id and operation;
- trigger and local next run time;
- condition, session, target, delivery, and termination choices;
- verification source, such as SDK re-read or `rin status --json`;
- active run status when operation changes a running task;
- follow-up boundary when the scheduler record is correct but another system must still change.

## Troubleshooting contract

- Task stayed idle: inspect `enabled`, `completedAt`, `pausedAt`, `nextRunAt`, `condition.lastResult`, `lastError`, and `rin status --json`.
- Run-now finished without a recipient-visible report: inspect `running`, `lastStartedAt`, active frontend turn, `lastError`, `frontend`, and `deliverFinal`.
- Recurring task is noisy: add `condition`, lower `thinkingLevel`, or change the prompt to report only changed evidence.
- Report formatting is raw: replace direct `shell_command` delivery with an `agent_prompt` wrapper.
