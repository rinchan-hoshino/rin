# Agent SDK

Rin exposes a small local agent SDK for daemon-backed operations that agents should not perform by hand with raw RPC payloads.

Use it from Node scripts when you need scheduled-task control or common chat operations. This SDK is a Rin source/runtime-internal helper; it is not a public npm import surface.

Run scripts that import Rin source modules with `node --import tsx script.mjs`.

```js
import path from "node:path";
import { pathToFileURL } from "node:url";

const rinAppDir = path.join(process.env.HOME, ".rin", "app", "current");
const sdkUrl = pathToFileURL(
  path.join(rinAppDir, "src", "core", "rin-agent-sdk", "index.ts"),
).href;
const { createRinAgentSdk } = await import(sdkUrl);

const rin = createRinAgentSdk();
```

Options:

```js
const rin = createRinAgentSdk({
  timeoutMs: 30_000,
});
```

## Scheduled tasks

Read `~/.rin/docs/rin/docs/scheduled-tasks.md` before creating or changing tasks. Use these helpers instead of constructing `cron_*` daemon RPC calls directly.

```js
const { tasks } = await rin.tasks.list();
const { task } = await rin.tasks.get("cron_example");
await rin.tasks.upsert({
  id: "cron_example",
  name: "Example",
  enabled: true,
  trigger: { expression: "0 9 * * *", timezone: "local" },
  condition: {
    code: "return context.task.runCount === 0 || Boolean(context.task.lastError)",
  },
  termination: { maxRuns: 10 },
  session: { mode: "none" },
  target: { kind: "agent_prompt", prompt: "Run the check and report changes." },
});
await rin.tasks.pause("cron_example");
await rin.tasks.resume("cron_example");
await rin.tasks.rescheduleOnce("cron_example", "2026-05-08T15:00:00+08:00");
await rin.tasks.run("cron_example");
await rin.tasks.wake("cron_example");
await rin.tasks.control("pause", "cron_example");
await rin.tasks.complete("cron_example", "finished");
await rin.tasks.delete("cron_example");
```

Helper semantics:

- `list()` returns agent-created task records visible through the daemon.
- `get(taskId)` inspects one visible task.
- `upsert(task, defaults?)` creates or updates a task; matching `id` merges with the existing record. Use `condition: null`, `termination: null`, or `frontend: null` to remove those optional fields.
- `run(taskId)` starts the existing task through the scheduler path and still evaluates `condition`; it does not clone the task or change its definition.
- `wake(taskId)` only moves the task's next run time to now; the scheduler tick then evaluates its condition normally. Use this for event notifications that should behave like a timer nudge rather than a forced run.
- `pause(taskId)` disables future runs, records `pausedAt`, clears `nextRunAt`, and asks chat runtime to terminate the task turn when applicable.
- `resume(taskId)` enables the task, clears `pausedAt`, and recomputes `nextRunAt`.
- `rescheduleOnce(taskId, runAt)` is only for one-time tasks; it sets `trigger.runAt`, sets `nextRunAt`, clears completed/paused state, and enables the task.
- `complete(taskId, reason?)` disables future runs while keeping the record and completion reason.
- `delete(taskId)` removes the record.

After writes, re-read with `get()` or `list()` and use `rin status --json` when liveness or next-run timing matters.

## Chat operations

```js
await rin.chat.send({
  chatKey: "telegram/123456:7890",
  text: "Ready.",
});

const result = await rin.chat.runTurn({
  chatKey: "telegram/123456:7890",
  text: "Write a short status update for this room.",
  controllerKey: `agent-${Date.now()}`,
  deliveryEnabled: true,
  affectChatBinding: false,
  disposeAfterTurn: true,
});

await rin.chat.terminateTurn("agent-controller-key");

const bridgeResult = await rin.chat.evalBridge({
  currentChatKey: "telegram/123456:7890",
  requestId: "agent-example",
  code: "return { ok: true, chatKey: currentChatKey };",
});
```

Use `runTurn` for assistant turns and `send` for direct outbox delivery. Keep lower-level platform adapter SDK use for operations that are not covered here, such as moderation or platform-specific member lookup.
