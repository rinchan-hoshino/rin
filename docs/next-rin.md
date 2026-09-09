# Current direction

Rin is a small bridge around an agent the user already installed.

The public core owns durable chat ingress and delivery, the Nerve event queue, normalized agent events, stable launchers, isolated updates, and its own user service. Agent configuration, private identity, credentials, and event-source policy stay outside the repository.

The daemon does not manage agent servers. Codex app-server control exists only through explicit CLI commands. Claude Code, pi, and OpenCode resume an existing native session through their documented non-interactive command. Their adapters report only output that the real command produced.

Discord, Telegram, and OneBot v11 are independent transports. OneBot is the supported path for ordinary QQ accounts. The QQ official Bot API has been removed.

Chat admission always starts with an explicit user ID list. Ordinary messages then pass deny and allow chat rules, private/group rules, mention rules, and binding checks before media is downloaded. A registered command still requires an authorized user but bypasses chat rules, DM-only, and mention gates. Telegram and OneBot may treat a group as private only after a fresh complete proof that the agent and exactly one authorized owner are its only members.

Quiet is a delivery setting. It suppresses working, commentary, and summary output for a route while final answers and errors remain visible. It does not discard input or stop the agent.

Nerve is agent-neutral. It sends a durable event to a configured command or HTTP target and records the delivery receipt. It neither creates agent tasks nor sends work through ChatBridge.

Installation is distributed as a prompt after the agent is installed. Persona design is a separate prompt. Private cost-optimization material is not part of this repository.
