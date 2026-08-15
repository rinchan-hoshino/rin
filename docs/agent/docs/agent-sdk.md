# Agent SDK

Use Rin's local Agent SDK when an agent needs daemon-backed operations from a short Node script.

The SDK is an installed-runtime entrypoint. Import it from the active installation under `~/.rin/app/current/dist` so the script targets the same code as the running Rin daemon.

## Prompt brief

Target surface:

- installed runtime SDK module: `dist/core/rin-agent-sdk/index.js`;
- the daemon socket selected by the active installation;
- short local scripts run with `tsx`.

Goal:

- import the active SDK, execute the domain operation, verify its result through the owning domain surface, and report only proven state.

Trusted inputs:

- active installed runtime path;
- target ids supplied by the user or read from daemon state;
- SDK return values and errors;
- the narrow domain document for the requested operation.

Output contract:

- SDK target and operation;
- result or error observed;
- verification read for mutations;
- remaining runtime, adapter, account, or approval boundary.

## Success criteria

An SDK script is complete when:

- it imports from the active installed runtime;
- it uses the high-level operation defined by the domain document;
- a mutation is followed by a domain read that proves the resulting state;
- an error or timeout is classified without guessing whether a mutation completed;
- the final report names the operation, verification source, and remaining boundary.

## Domain routes

Read the document that owns the requested behavior before writing the script:

- status, doctor, and self-improve diagnostics: `docs/diagnostic-commands.md`;
- session and process inspection: `docs/session-awareness.md`;
- scheduled task operations: `docs/scheduled-tasks.md`;
- chat delivery, stored messages, bridge state, and chat-bound turns: `docs/chat-bridge.md`;
- rich chat objects and attachments: `docs/rich-text-output-format.md`.

Prefer a purpose-built live tool when the current turn provides one. Use the SDK when the operation must be scripted, repeated, or composed with local verification.

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
- `socketPath`: override only when intentionally targeting a non-default daemon socket.

Each SDK operation also accepts an optional final override argument with the same options.

## Execution contract

- Resolve the SDK module through `~/.rin/app/current/`; do not import a source checkout when operating the installed daemon.
- Use the high-level operation and payload defined by the owning domain document.
- Treat the returned payload as the result for that request, not proof of unrelated runtime or recipient state.
- After a mutation, re-read through the owning domain API or its documented status surface.
- When active work changes, verify both the durable record and the active producer state.

## Error contract

SDK operations reject on local input validation, socket failures, daemon error responses, malformed responses, and request timeouts.

- Preserve the original error and operation name when reporting or diagnosing failure.
- A timeout proves that no response arrived before the deadline; it does not prove that a submitted mutation did not run. Read the owning state before deciding whether to retry.
- For import or connection failures, verify `~/.rin/app/current/`, the intended user and daemon, and the active socket. Use `docs/runtime-layout.md` for installation paths and `docs/diagnostic-commands.md` for daemon health.
- Do not silently switch to a source checkout, another user's daemon, or a different socket to make a request succeed.

## Final report contract

For scripted SDK work, report:

- active installed runtime and target surface;
- requested operation;
- returned result or exact error;
- verification read and key state observed;
- remaining boundary when another runtime, adapter, account, deployment, or owner decision is still required.
