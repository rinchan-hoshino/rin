# Current direction

Rin is a small bridge connecting chat conversations to a coding agent.

The public core owns durable chat ingress and delivery, the Nerve event queue, normalized agent events, stable launchers, isolated updates, and its own user service. Agent credentials, private identity, event-source policy, and persona content stay in the selected private configuration.

Codex uses app-server; Claude Code, pi, and OpenCode use their documented non-interactive session commands. The guided installation identifies its current agent and enables a fresh conversation for each admitted chat. Each adapter creates and continues native sessions and reports public answer output.

Discord, Telegram, and OneBot v11 are independent transports. OneBot is the supported path for ordinary QQ accounts.

Chat admission starts with an explicit user ID list. Messages then pass deny and allow chat rules, private/group rules, mention rules, and binding checks before media is downloaded. Registered commands still require an authorized user and use their command admission path.

Quiet is a delivery setting. It suppresses working, commentary, and summary output for a route while final answers and errors remain visible.

Nerve sends durable events to configured command or HTTP targets and records delivery receipts.
