# Scheduled Tasks Reference

Read `scheduled-tasks.md` first. Use this reference only for exact task fields, condition execution, termination, targets, delivery lifecycle, examples, or troubleshooting.

## Task record reference

### Writable task definition

Pass only desired task state to `upsert()`:

```ts
type WritableTaskPatch = {
  id?: string;
  name?: string;
  enabled?: boolean;
  frontend?: { kind: "chat" | "sdk"; key: string } | { kind: "tui" } | null;
  quiet?: boolean;
  trigger?: {
    expression?: string;
    timezone?: "local";
    runAt?: string;
    startAt?: string;
  };
  termination?: { maxRuns?: number; stopAt?: string } | null;
  condition?: { code: string; timeoutMs?: number } | null;
  target?:
    | { kind: "agent_prompt"; prompt: string; continuationPrompt?: string }
    | { kind: "shell_command"; command: string; timeoutMs?: number };
};
```

Creating a task requires both `trigger` and `target`; an update with a matching `id` may omit either field to preserve its existing value. An `agent_prompt` also requires an addressable `frontend`; `shell_command` may omit it. Include only the writable fields you intend to change. Use `frontend: null` only for shell tasks, and use `termination: null` or `condition: null` to remove those optional fields.

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

For agent-backed tasks, the scheduler owns the trigger and a durable invocation receipt, while the ordinary frontend session/turn runtime remains authoritative for execution and terminal completion. The receipt snapshots the submitted prompt, frontend identity, and stable turn identity before dispatch. After a daemon restart, Rin attaches to that same turn instead of submitting the prompt again. `running` and the `last*` fields are scheduler projections of this lifecycle; the internal receipt is intentionally omitted from task APIs.

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
  frontend: { kind: "chat", key: "telegram/123456:7890" },
  trigger: { expression: "*/30 * * * *", timezone: "local" },
  termination: { maxRuns: 1, stopAt: "2026-06-01T00:00:00+08:00" },
  condition: {
    code: `async () => {
      const response = await fetch("https://example.invalid/status");
      return response.ok && (await response.json()).ready === true;
    }`,
    timeoutMs: 5000,
  },
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

A scheduled `agent_prompt` is a delayed frontend input, not a session owner. It requires `frontend` and submits `target.prompt` through that frontend's ordinary input path.

Resolution is deliberately simple:

1. Address the configured frontend identity.
2. If it has a current session, submit there.
3. If it has no current session, let the frontend perform its ordinary first-input initialization and establish the binding.
4. For Chat input, create one first-class incoming message; visible input uses the delivered provider ID, while hidden input uses a stable internal ID.

The scheduler never supplies a session selector, restore path, managed-session leaf, model override, capability override, or `affectChatBinding` switch. Missing `frontend` fails with `cron_frontend_required`.

The first run uses `target.prompt`; later runs use `target.continuationPrompt` when present and otherwise reuse `target.prompt`. Reliable task facts, progress, ledgers, and decisions still belong in explicit external state. Removed session/model/capability fields are stripped from legacy persisted records and do not appear in normalized task APIs.

## Target contract

### `target.kind: "agent_prompt"`

Runs an agent turn. Use this for owner-facing reports, summaries, checks that need reasoning, and tasks that should produce polished chat text.

- The bound frontend session owns model, thinking, tools, and capabilities; the task changes none of them.
- Rin stores a summarized final result in `lastResultText`.
- If the agent turn has no canonical final assistant text, the task records `lastError`.

### `target.kind: "shell_command"`

Runs a shell command from the Rin user's home directory using the configured shell, `/bin/bash`, PATH `bash`, or `sh` fallback.

Use this for machine-style diagnostics and stable scripts. If the recipient expects a domain summary, use an `agent_prompt` task that runs the script and summarizes the result. Shell delivery includes machine fields like `Command`, `Exit`, `stdout`, and `stderr`.

Shell stdout/stderr are summarized before storage and delivery. A positive `timeoutMs` bounds one command execution; it defaults to 30 minutes and is normalized to the range from 100 ms through 24 hours. When the deadline expires, Rin terminates the command and its process group where supported, records `cron_shell_command_timeout:<milliseconds>`, and releases the task so later scheduled runs are not blocked.

## Delivery modes

Choose one delivery policy:

- Agent task with `frontend` and `quiet: false`: allow automatic final delivery and defer progress visibility to the frontend's own quiet setting. A non-quiet Chat displays the marked scheduled input and progress; a quiet Chat suppresses them.
- Agent task with `frontend` and `quiet: true`: submit the input but suppress automatic frontend messages; use this only when the authorized task prompt deliberately owns a separate outbound SDK action.
- Shell task with a Chat `frontend` and `quiet: false`: display the marked command and automatically deliver its output.
- Shell task without `frontend`: store the result without automatic delivery.

An addressable `frontend` routes execution through that frontend's current session and initializes the frontend normally when no current session exists. `frontend: { kind: "chat", key: "..." }` also selects the Chat destination. TUI is the singleton `{ kind: "tui" }` identity.

For visible Chat runs, Rin emits `⏰ Scheduled task · <name>` followed by the exact submitted prompt or shell command before Working begins. Automatic final or shell output replies to that marker where the platform supports quotes. Chat persists the provider message ID directly as an unprocessed `user` message and atomically commits its durable inbox item; it never records an assistant output and later converts it. Hidden Chat input skips platform presentation, receives a stable internal ID, and enters the same inbox/admission/turn consumer. Presentation policy changes only visibility, not execution ownership. Only `taskId` and `taskName` extend ordinary Chat prompt metadata; delivery and run identifiers stay in scheduler/outbox provenance.

Working, interim, independent-error, and final messages remain the frontend's one automatic delivery policy; do not add separate scheduler switches for them. Delivery idempotency and the one-frontend/one-session invariant are runtime guarantees, not task options.

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
  trigger: { expression: "30 8 * * *", timezone: "local" },
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
  frontend: { kind: "chat", key: "telegram/123456:7890" },
  trigger: { runAt: "2026-05-08T13:30:00+08:00" },
  target: {
    kind: "agent_prompt",
    prompt: "Send the user a concise reminder: drink water.",
  },
});
```

### Recurring frontend input

```js
await rin.tasks.upsert({
  id: "cron_guided_thread",
  name: "Guided recurring thread",
  enabled: true,
  frontend: { kind: "chat", key: "telegram/123456:7890" },
  trigger: { expression: "0 9 * * 1", timezone: "local" },
  target: {
    kind: "agent_prompt",
    prompt:
      "Read the external project state, run the approved weekly check, and report changed findings or blockers.",
  },
});
```

The prompt is submitted to the frontend's current worker each week. It does not own a parallel recurring conversation.

### Shell check

```js
await rin.tasks.upsert({
  id: "cron_disk_check",
  name: "Disk check",
  enabled: true,
  trigger: { expression: "0 * * * *", timezone: "local" },
  target: { kind: "shell_command", command: "df -h" },
});
```

## Final report contract

Report:

- task id and operation;
- trigger and local next run time;
- condition, frontend, target, delivery, and termination choices;
- verification source, such as SDK re-read or `rin status --json`;
- active run status when operation changes a running task;
- follow-up boundary when the scheduler record is correct but another system must still change.

## Troubleshooting contract

- Task stayed idle: inspect `enabled`, `completedAt`, `pausedAt`, `nextRunAt`, `condition.lastResult`, `lastError`, and `rin status --json`.
- Run-now finished without a recipient-visible report: inspect `running`, `lastStartedAt`, active frontend turn, `lastError`, `frontend`, and `quiet`.
- Recurring task is noisy: add a `condition`, persist a deduplication/change-detection key, narrow delivery, or change the prompt to report only changed evidence.
- Report formatting is raw: replace direct `shell_command` delivery with an `agent_prompt` wrapper.
