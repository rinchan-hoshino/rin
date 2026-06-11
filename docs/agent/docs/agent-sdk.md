# Agent SDK

Use Rin's local Agent SDK when an agent needs daemon-backed operations from a short Node script.

The SDK is an installed-runtime helper. Import it from the active installed runtime under `~/.rin/app/current/dist` so scripts target the same code that the running Rin installation uses.

## Prompt brief

Target surface:

- installed runtime SDK module: `dist/core/rin-agent-sdk/index.js`;
- daemon-backed task, chat, status, and built-in-extension operations;
- short local scripts run with `tsx`.

Goal:

- perform a structured daemon operation, re-read the changed or inspected object, and report the verified state.

Trusted inputs:

- active installed runtime path;
- task/chat/extension ids supplied by the user or read from daemon state;
- SDK return values;
- `rin status` / `rin status --json` for operator-facing status and liveness.

Output contract:

- operation and target id;
- SDK helper used;
- verification read/result;
- active producer state when the operation changes running work;
- follow-up boundary such as restart, adapter action, or owner confirmation when the SDK operation is only one step.

## Success criteria

An SDK script is complete when:

- it imports from the active installed runtime;
- it uses the high-level helper for the target surface;
- write operations are followed by a re-read through SDK or status command;
- active work changes verify liveness as well as record state;
- the final report names the object id, operation, verification source, and remaining boundary.

## When to use it

Use the SDK for:

- scheduled-task create/read/update/run/pause/resume/delete operations;
- chat bridge sends, agent turns, typing, reactions, turn termination, and bridge-local evals;
- daemon status/activity checks when a script needs structured daemon data;
- installed built-in extension enable/disable/list operations.

Prefer direct turn tools when the current turn already has a purpose-built tool. Use the SDK when the operation must be scripted, repeated, or composed with local verification.

Read the topic document before changing that surface:

- scheduled tasks: `docs/scheduled-tasks.md`;
- chat bridge behavior: `docs/chat-bridge.md`;
- rich chat output syntax: `docs/rich-text-output-format.md`;
- built-in extensions: `docs/builtin-extensions.md`.

## Import pattern

Run local scripts with `tsx script.ts`.

```js
import path from "node:path";
import { pathToFileURL } from "node:url";

const rinAppDir = path.join(process.env.HOME, ".rin", "app", "current");
const sdkUrl = pathToFileURL(
  path.join(rinAppDir, "dist", "core", "rin-agent-sdk", "index.js"),
).href;
const { createRinAgentSdk } = await import(sdkUrl);

const rin = createRinAgentSdk({
  timeoutMs: 30_000,
});
```

Options:

- `timeoutMs`: daemon request timeout for SDK calls.
- `socketPath`: override when intentionally targeting a non-default daemon socket.

Each helper also accepts an optional final override argument with the same options.

## Scheduled task helpers

Use these helpers for scheduler records. Read `docs/scheduled-tasks.md` for task-shape, session-mode, trigger, condition, prompt, and verification contracts.

```js
const { tasks } = await rin.tasks.list();
const { task } = await rin.tasks.get("cron_example");

await rin.tasks.upsert({
  id: "cron_example",
  name: "Example",
  enabled: true,
  trigger: { expression: "0 9 * * *", timezone: "local" },
  session: { mode: "none" },
  target: { kind: "agent_prompt", prompt: "Run the check and report changes." },
});

await rin.tasks.run("cron_example");
await rin.tasks.wake("cron_example");
await rin.tasks.rescheduleOnce("cron_example", "2026-05-08T15:00:00+08:00");
await rin.tasks.pause("cron_example");
await rin.tasks.resume("cron_example");
await rin.tasks.complete("cron_example", "finished");
await rin.tasks.delete("cron_example");
```

Helper contract:

- `rin.tasks.list()` returns agent-visible scheduled tasks.
- `rin.tasks.get(taskId)` reads one agent-visible task.
- `rin.tasks.upsert(task, defaults?)` creates or updates a task; pass `condition: null`, `termination: null`, or `frontend: null` to remove optional fields.
- `rin.tasks.run(taskId)` starts the existing task through scheduler semantics, including condition evaluation.
- `rin.tasks.wake(taskId)` moves the next run to now; the scheduler still evaluates the task normally.
- `rin.tasks.rescheduleOnce(taskId, runAt)` sets the next run time and updates one-time `trigger.runAt` while preserving recurring cron expressions.
- `rin.tasks.pause(taskId)` disables future runs, records pause state, clears next-run state, and asks Rin to stop applicable active task turns.
- `rin.tasks.resume(taskId)` enables the task and recomputes next-run state.
- `rin.tasks.complete(taskId, reason?)` disables future runs while keeping the task record and reason.
- `rin.tasks.delete(taskId)` removes the task record.
- `rin.tasks.control("pause" | "resume", taskId)` is the low-level pause/resume helper; the named helpers are the normal script surface.

After any write, re-read with `rin.tasks.get()` or `rin.tasks.list()`. When timing, liveness, or active producers matter, also check `rin status --json`.

## Chat helpers

Use `rin.chat.send` for direct outbox delivery. Use `rin.chat.runTurn` when Rin should run an assistant turn for a chat or frontend identity.

```js
await rin.chat.send({
  chatKey: "telegram/123456:7890",
  text: "Ready.",
});

const result = await rin.chat.runTurn({
  chatKey: "telegram/123456:7890",
  text: "Write a short status update for this room.",
  controllerKey: `agent-${Date.now()}`,
  affectChatBinding: false,
  disposeAfterTurn: true,
});

await rin.chat.typing("telegram/123456:7890");
await rin.chat.react({
  chatKey: "telegram/123456:7890",
  messageId: "message-id",
  emoji: "👍",
});
await rin.chat.terminateTurn("agent-controller-key");

const bridgeResult = await rin.chat.evalBridge({
  currentChatKey: "telegram/123456:7890",
  requestId: "agent-example",
  code: "return { ok: true, chatKey: currentChatKey };",
});
```

Chat helper contract:

- `send(payload)` posts explicit text or adapter parts to a chat target.
- `runTurn(payload)` runs an assistant turn; set `affectChatBinding`, `disposeAfterTurn`, `shutdownAfterTurn`, and `deliverFinal` deliberately.
- `typing(target)` sends a typing indicator when the adapter supports it.
- `react(payload)` sends a platform reaction when the adapter supports it.
- `terminateTurn(target)` stops the active turn by controller key or chat key.
- `evalBridge(payload)` evaluates code inside the chat bridge context for bridge-local inspection or repair.

For native mentions, quotes/replies, files, images, or attachment syntax, read `docs/rich-text-output-format.md` before sending. For stored chat logs, identities, adapters, and bridge state, read `docs/chat-bridge.md`.

## Daemon and built-in extension helpers

```js
const status = await rin.daemon.status();
const activity = await rin.daemon.activity();

const { extensions } = await rin.builtInExtensions.list();
await rin.builtInExtensions.enable("rin:browse");
await rin.builtInExtensions.disable("rin:browse");
await rin.builtInExtensions.setEnabled("rin:browse", true);
```

Use daemon helpers for structured inspection inside scripts. Use `rin status` or `rin status --json` for operator-facing status reports.

Use built-in extension helpers for installed built-in extension state. Read `docs/builtin-extensions.md` first; some capability changes also require dependency setup, service start/stop, or runtime restart outside a simple enable flag.

## Final report contract

For scripted SDK work, report:

- helper surface and target id;
- requested operation;
- verification read and key fields returned;
- active producer state for pause/resume/delete/complete/terminate operations;
- follow-up boundary when another runtime, adapter, account, or deployment action remains.
