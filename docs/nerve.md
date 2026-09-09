# Nerve

Nerve is a durable, agent-neutral event delivery queue. Producers send a stable ID, configured target, optional stable source ID, and JSON payload. Reusing the same ID with different content is rejected.

Targets are declared as an argv array or an HTTP URL. Nerve never accepts a command from an event body. Command targets receive one JSON value on stdin. HTTP targets receive the payload with an `Idempotency-Key` header.

`done` means the target accepted delivery. It does not mean an agent completed a turn. A process stop during delivery becomes `uncertain`; operators inspect external effects before retrying. Automatic retries require an explicitly idempotent target or an explicitly retryable command receipt.

Nerve does not create, bind, start, stop, or supervise agent sessions. An external command or HTTP target may submit work to any installed agent without going through ChatBridge.

The optional local MCP wrapper exposes health, event listing, event lookup, enqueue, and explicit retry. Registration is a manual installation choice.

Legacy configurations that contain `taskRouting` are rejected rather than
silently reinterpreted. Follow the [migration procedure](nerve-migration.md)
to preserve the database and move agent-specific submission into an explicit
command or HTTP target.
