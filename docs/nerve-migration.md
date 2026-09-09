# Nerve migration from legacy task routing

The lightweight Nerve runtime does not interpret `taskRouting`, `codex-app`,
or agent task IDs. It delivers a durable event to an explicitly declared
command or HTTP target. This keeps Nerve independent from the agent that owns
the session.

Before changing a live installation:

1. Stop producers and the Nerve service through the existing service owner.
2. Copy `nerve.json`, its secrets file, and the SQLite database to an
   owner-only backup directory. Keep the original files untouched until the
   candidate has accepted a real receipt.
3. For each target, remove `taskRouting`. Keep the target name stable so
   pending events retain their destination. Keep or replace the target's
   `argv` with a wrapper that accepts the documented JSON event on stdin and
   returns `{"accepted":true,...}` only after it has durably accepted the
   event. Do not put an agent task ID in an event body as a substitute for a
   target contract.
4. Point the candidate configuration at a copied database and run:

   ```sh
   node src/nerve.mjs check /path/to/candidate/nerve.json
   node src/nerve.mjs status /path/to/candidate/nerve.json
   ```

   `check` validates the new target schema and rejects legacy `taskRouting`.
   `status` must show the copied pending, done, failed, and uncertain rows.
5. Exercise the wrapper with one disposable event and record its receipt. A
   receipt means that the target accepted the event; it does not prove that an
   agent completed a model turn. Do not submit a real model request until the
   selected agent's session, credentials, and cancellation behavior have been
   separately verified.
6. Only after the receipt and row preservation are reviewed, replace the
   service's configuration and database atomically, then restart the service.
   Re-check `/health`, event status, and the producer logs. If any check fails,
   stop the candidate and restore the untouched backup.

The old configuration must fail validation while it still contains
`taskRouting`; this is deliberate protection against silently dropping the
old binding. A migration is complete only when the old task binding has an
explicit command or HTTP owner and the owner has acknowledged the event.

## Keeping native task semantics outside Rin

If the old target selected a native agent task, keep that behavior in a
versioned private wrapper owned by the agent integration. The wrapper should:

- receive `{id, source, payload}` on stdin;
- select a task from a private `source -> session` map, falling back to one
  explicitly configured default session;
- submit `payload.prompt` through the agent's documented native input API or
  CLI, without accepting a destination task ID from untrusted payload text;
- write one JSON receipt with `accepted: true` only after the native client
  returns its admission ID, and mark a pre-admission refusal as retryable;
- preserve the event ID and source in its own idempotency record.

This preserves source-to-native-task routing while leaving the public core
unaware of Codex UUIDs, `CODEX_HOME`, or another agent's session format. A
single fixed task can use the existing command target argv as the default
session; multiple tasks require the wrapper's private map and a separate
per-source migration review. Do not migrate by merely deleting
`taskRouting` when the old target did not already encode the same session
choice in its explicit wrapper arguments.

For multiple native sessions, keep the mapping outside the public Nerve file,
for example:

```json
{
  "default": "<main-native-session>",
  "group-social-attention": "<shared-group-native-session>"
}
```

Before enabling delivery, the private adapter should connect to the native
agent protocol and resume each mapped session without starting a turn. Verify
that each source selects the intended session, then record a zero-turn check.
The first real event still requires a separate operator decision because it
may send a model request and create an external side effect.
