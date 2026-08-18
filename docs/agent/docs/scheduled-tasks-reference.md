# Scheduled Tasks Reference

Read `scheduled-tasks.md` first. Use this reference only for exact task fields, condition execution, termination, dedicated sessions, targets, delivery lifecycle, examples, or troubleshooting.

## Task record reference

### Writable task definition

Pass only desired task state to `upsert()`:

```ts
type WritableTaskPatch = {
  id?: string;
  name?: string;
  enabled?: boolean;
  frontend?: { kind?: string; key: string } | null;
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
  disabledRinCapabilities?: string[] | null;
  trigger?: {
    expression?: string;
    timezone?: "local";
    runAt?: string;
    startAt?: string;
  };
  termination?: { maxRuns?: number; stopAt?: string } | null;
  condition?: { code: string; timeoutMs?: number } | null;
  session?: { mode: "none" | "dedicated" };
  target?:
    | { kind: "agent_prompt"; prompt: string; continuationPrompt?: string }
    | { kind: "shell_command"; command: string };
};
```

Creating a task requires both `trigger` and `target`; an update with a matching `id` may omit either field to preserve its existing value. Include only the writable fields you intend to change. Use `frontend: null`, `termination: null`, `condition: null`, or `disabledRinCapabilities: null` to remove those optional fields.

### Read-only lifecycle state

Task reads return normalized task fields plus scheduler-owned lifecycle state. The returned `condition` combines its writable definition with the latest evaluation result. Observe these fields; use the dedicated run, pause, resume, complete, reschedule, or delete operations instead of trying to write lifecycle results through `upsert()`:

```ts
type ReadOnlyTaskLifecycleState = {
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  completedAt?: string;
  completionReason?: string;
  pausedAt?: string;
  runCount: number;
  running: boolean;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastResultText?: string;
  lastError?: string;
  dedicatedSessionFile?: string;
  condition?: {
    code: string;
    timeoutMs?: number;
    lastEvaluatedAt?: string;
    lastResult?: boolean;
    lastOutput?: string;
  };
};
```

The daemon loads the persisted task file at startup and when explicitly requested through `rin tasks reload` or `rin.tasks.reload()`: valid JSON edits, additions, and removals take effect without restarting the daemon only after that reload command. Invalid JSON leaves the running daemon schedule unchanged and makes the reload fail, so a partial manual edit does not silently replace the in-memory schedule.

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

Use `condition` for a cheap, deterministic, read-only boolean gate that avoids an unnecessary target run. For conditional recurrence, add it only when all five are true:

1. the event time is unknown;
2. the work must continue after the current turn;
3. most scheduled checks should do nothing;
4. the check is cheaper than an agent turn;
5. one target action is needed when it becomes true.

Otherwise use `runAt`, a normal recurring target, or the current turn. Keep side effects in the target.

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
  id: "cron_wait_until_ready",
  name: "Act once when the source becomes ready",
  enabled: true,
  trigger: { expression: "*/30 * * * *", timezone: "local" },
  termination: { maxRuns: 1, stopAt: "2026-06-01T00:00:00+08:00" },
  condition: {
    code: `async () => {
      const response = await fetch("https://example.invalid/status");
      return response.ok && (await response.json()).ready === true;
    }`,
    timeoutMs: 5000,
  },
  session: { mode: "none" },
  target: {
    kind: "agent_prompt",
    prompt:
      "The condition proved the source ready. Perform the one approved action, verify it, and report the result.",
  },
});
```

For temporary conditional recurrence, use `maxRuns: 1` so the first true result runs the target once, and add `stopAt` so an event that never arrives cannot leave an endless task. Prefer this task lifecycle over a separate deduplication ledger when it proves the same invariant.

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

### `session.mode: "dedicated"`

Use when the task is intentionally a task-owned agent thread. The clearest signal is a setup `target.prompt` plus a distinct `target.continuationPrompt` for later runs.

Rin derives the session path from the task id:

```text
~/.rin/sessions/managed/task/<task-id>.jsonl
```

Behavior:

- First run uses `target.prompt`.
- Later runs use `target.continuationPrompt` when provided; otherwise they reuse `target.prompt`.
- The dedicated session persists across runs but never becomes a chat's current session merely because the task runs or delivers there. Quoting a delivered task message selects its linked session through the ordinary user-driven quote path.

Choose `dedicated` when the persistent conversation is part of the intended context, such as an intentionally guided recurring thread.

## Target contract

### `target.kind: "agent_prompt"`

Runs an agent turn. Use this for owner-facing reports, summaries, checks that need reasoning, and tasks that should produce polished chat text.

- `model` and `thinkingLevel` override the run when present.
- Rin stores a summarized final result in `lastResultText`.
- If the agent turn has no canonical final assistant text, the task records `lastError`.

### `target.kind: "shell_command"`

Runs a shell command from the Rin user's home directory using the configured shell, `/bin/bash`, PATH `bash`, or `sh` fallback.

Use this for machine-style diagnostics and stable scripts. If the recipient expects a domain summary, use an `agent_prompt` task that runs the script and summarizes the result. Shell delivery includes machine fields like `Command`, `Exit`, `stdout`, and `stderr`.

Shell stdout/stderr are summarized before storage and delivery.

## Delivery modes

Choose one delivery policy:

- No `frontend`: store the result without automatic delivery.
- `frontend` with `quiet: false`: automatic delivery.
- `frontend` with `quiet: true`: no scheduler-managed delivery; use this only when the authorized task prompt deliberately owns a separate outbound SDK action.

An addressable `frontend` routes execution through a task-owned controller. `frontend: { kind: "chat", key: "..." }` sends automatic output to that Chat destination without reading or changing the chat's current session binding. TUI frontends have no key and cannot be addressed.

Working, interim, independent-error, and final messages are one automatic delivery policy; do not add separate switches for them. Quote linkage, delivery idempotency, and chat-session isolation are runtime guarantees, not task options. Quoting a delivered task message selects its linked session through the ordinary user-driven quote path.

`quiet` defaults to `false`. When true, Rin still records task result and error state. An explicit outbound SDK send remains a separate side effect governed by the task prompt's authority and verification contract.

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
- Run-now finished without a recipient-visible report: inspect `running`, `lastStartedAt`, active frontend turn, `lastError`, `frontend`, and `quiet`.
- Recurring task is noisy: add a `condition`, persist a deduplication/change-detection key, narrow delivery, or change the prompt to report only changed evidence. Adjust `thinkingLevel` for computation cost, not notification frequency.
- Report formatting is raw: replace direct `shell_command` delivery with an `agent_prompt` wrapper.
