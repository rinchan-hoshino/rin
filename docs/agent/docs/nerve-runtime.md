# Nerve runtime

Rin's Nerve runtime keeps one serial main-brain session dormant until a trigger
emits an opaque sensation body. It does not classify the source or poll a model.

## Stimulus contract

```ts
await ctx.emit({
  dedupeKey: "optional-source-event-id",
  body: "the complete sensation presented to the main brain",
});
```

`body` is the only field presented to the model. `dedupeKey` is an optional
transport key used only to prevent duplicate delivery after a trigger restart.
The runtime does not own producer names, sensation classes, account identity,
trust, chat keys, or source-specific policy.

The queue is stored at `~/.rin/data/core/nerve/nerve.sqlite`. Its final schema
contains only the internal row ID, optional dedupe key, body, body hash,
delivery state, timestamps, and the last transport error.

## TypeScript triggers

Mutable triggers live at:

```text
~/.rin/nerve/triggers/*.ts
```

Each file exports one function:

```ts
export async function start(ctx: NerveTriggerContext): Promise<void> {
  // Subscribe to or inspect the source here.
}
```

The trigger—not NerveRuntime—owns source access, authentication, cursors,
filtering, interpretation, and the exact body the brain experiences. Runtime
starts each file in an isolated child process and provides:

```ts
type NerveTriggerContext = {
  triggerId: string;
  stateDir: string;
  signal: AbortSignal;
  emit(input: { dedupeKey?: string; body: string }): Promise<void>;
  sleepFor(milliseconds: number): Promise<void>;
  sleepUntil(time: string | Date): Promise<void>;
};
```

After changing a trigger, reload it without restarting the daemon:

```bash
rin nerve reload <trigger-id>
```

Trigger waiting is implemented by TriggerRuntime and does not use scheduled
tasks or Cron.

## Main brain

All bodies enter the single frontend identity `{ kind: "nerve", key: "main" }`
and managed session leaf `nerve-main-v2`. The SQLite queue remains a per-event
crash-recovery ledger. Runtime coalesces events that are still pending behind an
active turn into one ordered JSON-array batch by replacing the queued `steer`;
it never waits for an earlier task to finish before admitting new input. Once a
batch has been consumed, later events form the next batch. No second main brain
is created. A normal assistant final is not sent to a chat outbox. The brain
must choose and call an external tool when it wants to communicate.

The session retains the normal instance profile, skills, memory, transcript
archive, and `recall`. Automatic self-improve extraction remains limited to its
user-facing frontend policy and does not run for the Nerve frontend.

## CLI and SDK

```bash
rin nerve status --json
rin nerve emit --body "your Discord rang" --dedupe-key event-123 --json
rin nerve abort --json
rin nerve reload [trigger-id] --json
```

The Agent SDK exposes the same operations under `rinAgentSdk.nerve`.
