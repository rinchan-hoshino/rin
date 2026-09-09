# Lightweight Rin architecture

Rin is a durable chat and event bridge around an agent that the user installs and owns.

The core has three ports:

- `AgentBridge` accepts a message for an existing agent session and emits normalized public events.
- `ChatAdapter` receives and sends platform messages. Identity and chat admission happen before attachments are fetched.
- Nerve accepts durable events and delivers them to declared command or HTTP targets. It does not call ChatBridge.

The daemon composes these ports. It starts and stops Rin resources only: chat adapters, the local Nerve endpoint, producer scripts, and local stores. It never starts, stops, restarts, or supervises an agent server.

Codex uses its app-server client and history observer. Claude Code, pi, and OpenCode use their documented non-interactive CLI entrypoints and resume an existing session. CLI adapters emit a final answer after the process exits successfully; they do not invent intermediate events that the CLI did not expose.

`rin update` keeps the isolated candidate checkout, verification, atomic switch, and rollback behavior. Service commands manage Rin. `rin app-server start|restart` is an explicit Codex-only operator action and is never called by the daemon.

Installation is guided by `prompts/install.md` after the chosen agent is installed. The public repository does not install agents, rewrite their global configuration, manage unrelated launchers, or contain private identity and cost-optimization material.
