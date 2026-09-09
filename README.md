# Rin

Rin connects an installed coding agent to durable chat and event inputs.

The lightweight core supports:

- Codex through app-server
- Claude Code, pi, and OpenCode through their non-interactive CLIs
- Discord, Telegram, and OneBot v11 chat transports
- Nerve command and HTTP event delivery
- isolated Git updates, Rin service restart, and explicit Codex app-server management

Rin does not install or configure an agent and does not supervise agent servers. QQ accounts connect through OneBot; the QQ official Bot API is not supported.

Start with [the guided installation prompt](prompts/install.md). It asks for one decision at a time after your chosen agent is installed. The reusable [persona practice prompt](prompts/persona-practice.md) is a separate public artifact.

Runtime configuration is shown in [examples/chat.json](examples/chat.json) and [examples/nerve.json](examples/nerve.json). Architecture and behavioral rules are documented in [docs/architecture.md](docs/architecture.md), [docs/chat-bridge.md](docs/chat-bridge.md), [docs/nerve.md](docs/nerve.md), and [docs/nerve-migration.md](docs/nerve-migration.md).

Automated coverage and remaining real integration checks are tracked in [docs/validation.md](docs/validation.md).

Node.js 24 or newer is required. Build and test with:

```sh
npm ci
npm test
```

The repository is GPL-3.0-only.
