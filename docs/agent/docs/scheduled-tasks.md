# Scheduled Tasks

Use scheduled tasks only when work must happen after the current turn: a reminder, delayed follow-up, recurrence, conditional recurrence, or background task.

For an ordinary reminder or recurring report, this file is sufficient. Read `scheduled-tasks-reference.md` only for exact task fields, condition-code execution, termination edge cases, source-worker fallback, shell delivery, or lifecycle troubleshooting.

Import the installed Agent SDK exactly as shown in `agent-sdk.md`; examples below assume `const rin = createRinAgentSdk()`.

## Simple path

Choose only what the request needs:

1. **Operation:** create, inspect, update, run, pause, resume, complete, or delete.
2. **Trigger:** one-time `runAt` or recurring cron `expression` plus `timezone`.
3. **Target:** `agent_prompt` for reasoning and polished reports; `shell_command` for stable machine output.
4. **Delivery:** add an addressable `frontend` only when Rin should deliver automatically.
5. **Verification:** re-read the task and, for a run, wait for terminal task and external state.

Do not add legacy session/model/capability fields. Add `condition`, `quiet`, or `termination` only for a specific need.

## Minimal create

Create a one-time Chat reminder:

```js
await rin.tasks.upsert({
  id: "reminder_example",
  name: "Example reminder",
  enabled: true,
  trigger: { runAt: "2026-08-19T09:00:00+08:00" },
  target: {
    kind: "agent_prompt",
    prompt:
      "Remind the owner about the agreed item. State the item and due context briefly.",
  },
  frontend: { kind: "chat", key: chatKey },
});

const verified = await rin.tasks.get("reminder_example");
```

Use a stable descriptive `id`. Omit `frontend` for a task that should only record its result. Creating requires both `trigger` and `target`; updating an existing `id` may send only the fields being changed.

## Method map

- Reads: `rin.tasks.list()`, then `rin.tasks.get(id)` for exact fields.
- Writes: `rin.tasks.upsert(input)`, `rin.tasks.run(id)`, `rin.tasks.wake(id)`, `rin.tasks.rescheduleOnce(id, runAt)`, `rin.tasks.pause(id)`, `rin.tasks.resume(id)`, `rin.tasks.complete(id)`, `rin.tasks.delete(id)`, and `rin.tasks.reload()`.

After a mutation, re-read the exact `id`. For `run`, wait for terminal state. For pause, resume, complete, or reschedule, confirm the matching lifecycle fields. After delete, confirm `get` returns no task.

Use `reload()` only after an authorized direct edit to `~/.rin/data/scheduler/tasks.json`; normal SDK writes are already live.

## Optional field decisions

- **`condition`:** a cheap, deterministic, read-only boolean gate that avoids an unnecessary target run.
- **`termination`:** `maxRuns` or `stopAt` for bounded recurrence.
- **`quiet: true`:** only when the task prompt deliberately owns separate outbound delivery.

An `agent_prompt` task is only a delayed user input to an existing worker. It cannot create, select, resume, configure, or terminate a task-owned session. Legacy `session`, `model`, `thinkingLevel`, and `disabledRinCapabilities` fields may be read during migration but do not alter execution; use `/new` and the frontend's normal session controls outside the task.

Set an optional field to `null` in `upsert()` to remove it. Do not write scheduler-owned lifecycle fields such as `runCount`, `runningAt`, `nextRunAt`, or `lastError` through `upsert()`.

## Conditional recurrence gate

Use an ordinary `condition` for cheap deduplication or a deterministic no-op gate. For conditional recurrence, all five must be true:

1. the event time is unknown;
2. the work must continue after the current turn;
3. most scheduled checks should do nothing;
4. the check is cheaper than an agent turn;
5. one target action is needed when the condition becomes true.

A false recurring condition schedules the next tick without starting the target. For a temporary wait, use `maxRuns: 1` so the first true result runs once, and add `stopAt` so an event that never arrives cannot leave an endless task. Keep side effects in the target. Read the reference before authoring condition code.

## Delivery decision

- **Existing source worker only:** omit `frontend` only when task creation captured a valid `createdFrom.sessionFile`; execution fails closed if that session no longer exists.
- **Automatic: set `frontend` and keep `quiet: false`.** Rin submits the prompt to that frontend's one current session and owns Working, interim, independent-error, and final delivery as one policy.
- **Manual: set `frontend` and `quiet: true`.** The same bound worker receives the prompt, but no scheduler-managed message is sent; the authorized task prompt must explicitly perform and verify any outbound SDK action.

A Chat frontend uses `{ kind: "chat", key: chatKey }`; TUI is the singleton `{ kind: "tui" }`. A scheduled turn never changes the frontend binding. Replies to its deliveries remain ordinary quote rich text and never resume a task session.

## Task prompt

For `agent_prompt`, write a runnable contract rather than a vague description. Include only what changes execution:

- authoritative source and evidence;
- exact work and allowed side effects;
- no-change and duplicate-work behavior for recurrence;
- retry and stop conditions;
- validation before success;
- final report fields.

Use `rin-prompt-engineering` when creating or changing `target.prompt` or `target.continuationPrompt`. A scheduled task does not gain write, push, publish, payment, account, or deployment authority from its trigger.

## Verification

Re-read the task after every mutation. Compare the exact fields changed and preserve untouched lifecycle, trigger, session, delivery, and override fields.

For `run()` or `wake()`:

1. confirm the scheduler accepted the operation;
2. wait until the task is no longer running or an explicit timeout is reached;
3. re-read `lastRunAt`, `lastResultText`, `lastError`, lifecycle fields, and `nextRunAt`;
4. verify any task-owned file, message, API state, or artifact from its authoritative producer.

Acceptance of an operation is not proof that the target succeeded. Report the task `id`, operation, useful resulting state, external success evidence when applicable, and any remaining blocker. Keep secrets, full prompts, and long logs out of normal reports.

## Reference routing

Read `scheduled-tasks-reference.md` before handling any of these:

- exact writable/read-only DTO fields;
- condition TypeScript context, timeout, output, or failure behavior;
- frontend binding, source-worker fallback, or task-session migration;
- `shell_command` exit/stdout/stderr delivery;
- frontend quiet/manual delivery or quote/session incidents;
- scheduler lifecycle errors or detailed troubleshooting.
