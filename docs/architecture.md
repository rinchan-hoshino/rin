# Rin architecture

Rin is a durable bridge around an agent session selected by the user.

The core has three ports:

- `AgentBridge` accepts input for an agent session and emits normalized public events.
- `ChatAdapter` receives and sends platform messages. Identity and chat admission happen before attachments are fetched.
- Nerve accepts durable events and delivers them to declared command or HTTP targets. It does not call ChatBridge.

The daemon composes these ports and owns Rin resources: chat adapters, the local Nerve endpoint, producer scripts, and local stores. Codex uses its app-server client and history observer. Claude Code, pi, and OpenCode use their documented non-interactive CLI entrypoints and resume an existing session.

`rin update` verifies an isolated candidate, performs an atomic switch, and supports rollback. Service commands manage Rin. Codex app-server control is explicit through `rin app-server start|restart`.

Installation is guided by [prompts/install.md](../prompts/install.md). Identity, credentials, event-source policy, and persona content belong in the private configuration selected during that flow.
