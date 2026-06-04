# Scheduled Tasks

Use scheduled tasks when work should happen after the current turn: future reminders, recurrence, polling, conditional checks, or background automation.

A scheduled task is an automation contract. Its prompt and record define the trigger, evidence source, allowed work, side effects, delivery target, stop condition, and verification required before reporting success.

## Prompt brief

Target surface:

- daemon-owned scheduler records;
- Agent SDK `rin.tasks.*` helpers;
- optional chat/frontend delivery through the chat bridge;
- optional shell commands or agent turns.

Goal:

- convert a future, recurring, conditional, or background request into a verified scheduler record and a task prompt that can run without extra human prompting.

Trusted inputs:

- the user's requested time, recurrence, target chat, task goal, and permission boundary;
- existing task record when updating an id;
- current daemon/scheduler state from SDK reads or `rin status --json`;
- stored chat session metadata for `session_instruction` tasks.

Output contract:

- task id and operation performed;
- trigger and expected next local run time;
- condition/session/target/delivery/termination choices;
- verification result after re-reading task state;
- active producer status when pausing, completing, deleting, or terminating work.

## Success criteria

A scheduled-task operation is complete when:

- the task record expresses the smallest correct contract for the request;
- `target.prompt` or `target.command` has enough source-of-truth, scope, stop, validation, and report instructions to run later;
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
- **existing task control:** inspect, update, run now, wake, reschedule, pause, resume, complete, or delete.

When a single missing field changes the contract, ask for that field. Typical missing fields are exact time, target chat, action authority, or the event that should stop a watch task.

## Design contract

Choose the smallest task shape that preserves the user-visible contract:

1. **Operation:** create, inspect, update, run now, wake, reschedule, pause, resume, complete, or delete.
2. **Trigger:** one-time `runAt` or recurring cron `expression`.
3. **Condition gate:** optional TypeScript `condition` for cheap “only run if needed” checks.
4. **Target:** `agent_prompt` for reasoning or user-facing reports; `shell_command` for machine checks.
5. **Task prompt:** use `rin-prompt-engineering` for `target.prompt` and `target.continuationPrompt`.
6. **Session:** `none` for normal tasks; `dedicated` for a task-owned continuing thread; `session_instruction` for insertion into an existing chat session.
7. **Delivery:** optional `frontend`, chat binding, and `deliverFinal`.
8. **Termination:** optional `maxRuns` or `stopAt`.
9. **Verification:** re-read the task and check liveness when active producers matter.

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
- `target.kind`, prompt/command intent, `frontend`, and `deliverFinal`;
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
  model?: string;
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
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

`upsert()` merges with an existing task when `id` matches. Include the fields you intend to change. Use `frontend: null`, `termination: null`, or `condition: null` to remove those optional fields.

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
- If `frontend` is set, Rin binds the scheduled turn to that frontend/controller identity.
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

### `session.mode: "session_instruction"`

Use when the scheduled turn must be inserted into an existing stored chat session. Its context comes from `session.sessionFile`.

Use this for chat-thread follow-ups such as “come back to this conversation later and ask about the pending review”.

Scheduler-enforced requirements:

- `target.kind` must be `"agent_prompt"`.
- Omit `frontend`; Rin derives the existing frontend/chat binding from the stored session file.
- `session.sessionFile` must point to an existing stored session with a chat binding.
- Root `deliverFinal: false` updates the session while suppressing automatic final delivery.

Rin inserts the follow-up into the existing session without scheduled-task prompt-context injection.

## Target and delivery contract

### `target.kind: "agent_prompt"`

Runs an agent turn. Use this for owner-facing reports, summaries, checks that need reasoning, and tasks that should produce polished chat text.

- `frontend` binds execution to a frontend/controller identity.
- `frontend: { kind: "chat", key: "..." }` binds delivery to a chat bridge target.
- Root `deliverFinal: false` binds the turn while suppressing automatic final delivery.
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

### Current-session follow-up

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
- Current-session follow-up fails: verify the `sessionFile` exists and has a stored chat binding, then let Rin derive the frontend binding from that session.
