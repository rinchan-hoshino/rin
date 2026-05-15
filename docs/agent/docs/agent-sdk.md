# Agent SDK

Rin exposes a small local agent SDK for daemon-backed operations that agents should not perform by hand with raw RPC payloads.

Use it from Node scripts when you need scheduled-task control or common chat operations. This SDK is a Rin source/runtime-internal helper; it is not a public npm import surface.

Run scripts that import Rin source modules with `node --import tsx script.mjs`.

```js
import path from "node:path";
import { pathToFileURL } from "node:url";

const rinAppDir =
  process.env.RIN_APP_DIR ||
  path.join(process.env.HOME, ".rin", "app", "current");
const sdkUrl = pathToFileURL(
  path.join(rinAppDir, "src", "core", "rin-agent-sdk", "index.ts"),
).href;
const { createRinAgentSdk } = await import(sdkUrl);

const rin = createRinAgentSdk();
```

Options:

```js
const rin = createRinAgentSdk({
  socketPath: process.env.RIN_DAEMON_SOCKET_PATH,
  timeoutMs: 30_000,
});
```

## Scheduled tasks

```js
const { tasks } = await rin.tasks.list();
const { task } = await rin.tasks.get("cron_example");
await rin.tasks.upsert({ id: "cron_example", name: "Example", enabled: true });
await rin.tasks.pause("cron_example");
await rin.tasks.resume("cron_example");
await rin.tasks.rescheduleOnce("cron_example", "2026-05-08T15:00:00+08:00");
await rin.tasks.run("cron_example");
await rin.tasks.control("pause", "cron_example");
await rin.tasks.complete("cron_example", "finished");
await rin.tasks.delete("cron_example");
```

Use these helpers instead of constructing `cron_*` daemon RPC calls directly. `rescheduleOnce` is only for one-time tasks; it sets the next `runAt`, clears completed/paused state, and enables the task.

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
