# Agent SDK

Use Rin's local Agent SDK for daemon-backed operations that are not resident tools. For routine calls, this page is sufficient; read a domain document only for the complex cases listed below.

## Load the active SDK

Run the script with Node or `tsx`. Always import from `~/.rin/app/current`, never from a source checkout.

```js
import path from "node:path";
import { pathToFileURL } from "node:url";

const sdkUrl = pathToFileURL(
  path.join(
    process.env.HOME,
    ".rin/app/current/dist/core/rin-agent-sdk/index.js",
  ),
).href;
const { rinAgentSdk: rin } = await import(sdkUrl);
```

Use `createRinAgentSdk({ timeoutMs, socketPath })` instead of the singleton only when a non-default timeout or an intentionally different daemon socket is required.

## Method map

- `rin.daemon`: `status()`, `activity()`.
- `rin.sessions`: `list({ limit?, offset? })`.
- `rin.tasks` reads: `list()`, `get(taskId)`.
- `rin.tasks` writes: `upsert(task, defaults?)`, `delete(taskId)`, `complete(taskId, reason?)`, `pause(taskId)`, `resume(taskId)`, `rescheduleOnce(taskId, runAt)`, `run(taskId)`, `wake(taskId)`, `reload()`.
- `rin.chat` delivery: `send({ chatKey, text })` or `send({ chatKey, parts })`, `typing(chatKey)`, `react(payload)`.
- `rin.chat` turns: `runTurn(payload)`, `terminateTurn(controllerKey)` or `terminateTurn(payload)`.
- `rin.chat.messages`: `get({ chatKey, messageId })`, `list({ chatKey, before?, after?, limit? })`.
- `rin.chat` bridge-local: `evalBridge({ currentChatKey, requestId, code })`.

Every call accepts an optional final `{ timeoutMs, socketPath }` override.

## Read more only when needed

- recurring schedules, task schema, delivery, or lifecycle: `docs/scheduled-tasks.md`;
- rich chat parts, attachments, quotes, reactions, or delivery verification: `docs/chat-bridge.md` and `docs/rich-text-output-format.md`;
- bridge internals or platform actions through `evalBridge`: `docs/chat-bridge.md`;
- daemon/process diagnosis: `docs/diagnostic-commands.md`;
- install paths or target-user ambiguity: `docs/runtime-layout.md` and `docs/execution-environment.md`.

Do not read those larger documents for a simple status, list, get, pause/resume, plain-text send, or stored-message lookup.

## Result and error rules

- A mutation is complete only after a read from the owning domain proves the new state.
- A timeout proves only that no response arrived in time; read current state before retrying.
- Preserve the operation name and original error. Do not silently switch source checkout, user, daemon, or socket.
- Treat the returned payload as evidence for that request, not proof of recipient-visible delivery or unrelated runtime state.
