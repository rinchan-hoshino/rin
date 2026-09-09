# Nerve

Nerve is a durable, agent-neutral event delivery queue. Producers send a stable event ID, a configured target, an optional source ID, and a JSON payload. Reusing an ID with different content is rejected.

Targets are declared as an argv array or an HTTP URL. Command targets receive one JSON value on stdin. HTTP targets receive the payload with an `Idempotency-Key` header. Nerve never accepts executable commands from an event body.

`done` means the target accepted delivery. It does not mean an agent completed a turn. A process stop during delivery becomes `uncertain`; operators inspect external effects before retrying. Automatic retries require an explicitly idempotent target or an explicitly retryable command receipt.

Nerve does not create agent sessions or send work through ChatBridge. An external command or HTTP target may submit work to any installed agent. The optional local MCP wrapper exposes health, event listing, lookup, enqueue, and explicit retry. Registration is a manual installation choice.
