# Rin

参考 https://github.com/rinchan-hoshino/rin/blob/main/prompts/install.md 来帮我安装 Rin

Rin connects a coding agent to durable chat and event inputs.

The core provides:

- Codex through app-server
- Claude Code, pi, and OpenCode through their non-interactive CLIs
- Discord, Telegram, and OneBot v11 chat transports
- Durable Nerve command and HTTP event delivery
- Isolated updates, service lifecycle commands, and explicit Codex app-server controls

Choose and authenticate an agent, then follow the [guided installation prompt](prompts/install.md). The installer places a per-user `rin` command and user daemon without administrator access. Runtime configuration is shown in [examples/chat.json](examples/chat.json) and [examples/nerve.json](examples/nerve.json). The [persona practice prompt](prompts/persona-practice.md) is an optional separate artifact.

Read [the architecture guide](docs/architecture.md), [chat bridge rules](docs/chat-bridge.md), [Nerve guide](docs/nerve.md), and [validation guide](docs/validation.md) for the operating model and acceptance checks.

QQ accounts connect through OneBot v11. Node.js 24 or newer is required.

```sh
npm ci
npm test
```

The repository is GPL-3.0-only.
