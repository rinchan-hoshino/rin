# Nerve runtime

The nerve runtime owns one persistent main-agent session and an agent-writable set of TypeScript stimulus triggers. It is independent of scheduled tasks.

## Main-agent input

Every accepted stimulus enters frontend `{ kind: "nerve", key: "main" }` and managed session `nerve-main`. A stimulus received while the session is running uses steer admission; no second main-agent session is created. Ordinary assistant finals are not delivered to Chat.

The agent receives only the stimulus `body`. Queue identifiers, producer names, sensation labels, timestamps, trust decisions, and prompt-context metadata remain runtime-internal. Trigger authors therefore own the perceived form: a trigger may include full source content or emit only a cue such as `Your Discord rang.`

The dedicated owner-chat hard reflex is configured in `~/.rin/settings.json`:

```json
{
  "nerve": {
    "ownerChatKey": "discord/<bot-id>:<channel-id>"
  }
}
```

Only an `OWNER` message in that exact chat becomes a stimulus. Other messages in that dedicated chat are recorded without entering an ordinary Chat turn. The accepted message is presented as `<Platform> · <visible sender>\n<message body>`; the `OWNER` authorization label and account identifiers are not shown to the agent. `rin nerve status` exposes `ownerChatKey` so the agent can deliberately inspect or reply through the Chat SDK when needed.

## Trigger contract

Mutable triggers live at `~/.rin/nerve/triggers/*.ts`. The daemon starts each trigger in an isolated child process and gives it this structural interface:

```ts
export async function start({
  triggerId,
  stateDir,
  signal,
  emit,
  sleepFor,
  sleepUntil,
}) {
  // Subscribe, wait, or inspect a source. Emit only when the condition holds.
}
```

- `stateDir` is `~/.rin/nerve/state/<trigger-id>/`.
- `signal` aborts on reload or daemon shutdown.
- `sleepFor(milliseconds)` and `sleepUntil(time)` are abortable and task-independent.
- `emit({ id?, sensation, body })` enters the durable stimulus queue. Reuse a stable event id for retries.

After editing a trigger, run:

```bash
rin nerve reload <trigger-id>
```

A failed trigger does not restart in a loop. The main agent receives one `trigger_error` stimulus and may repair then reload it.

## CLI

```bash
rin nerve status
rin nerve reload [trigger-id]
rin nerve abort
rin nerve emit --producer <id> --sensation <name> --body <text>
```

Use `--id` for idempotent external retries and `--body-file` for multiline input.

## Session profile

The nerve session disables the `self_improve` source: its prompt block, managed self-improve skills, capability hooks, and distillation jobs are absent. Ordinary builtin/project skills and the memory/recall capability remain available.
