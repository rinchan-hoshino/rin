# Rin

Bring your coding agent into your chats.

Rin connects Codex, Claude Code, pi, and OpenCode to Discord, Telegram, and QQ (via OneBot v11).

## Install

Open a coding agent you have already installed and signed in to, then copy and send this prompt:

```text
Install and configure Rin using https://github.com/rinchan-hoshino/rin/blob/main/prompts/install.md
```

Rin uses the agent you are installing from. It will guide you through connecting your chats and deciding who can use it. Each chat starts its own conversation and keeps its context as you talk.

See the [installation guide](prompts/install.md) for the full steps. Node.js 24 or newer is required.

Run `rin` to open your configured agent, or `rin -- ...` to pass it arguments. Use `rin codex start|stop|restart` to manage the local Codex app-server.

## Features

- Codex through app-server
- Claude Code, pi, and OpenCode through their non-interactive CLIs
- Discord, Telegram, and OneBot v11 chat transports
- Durable Nerve command and HTTP event delivery
- Isolated updates, service lifecycle commands, and explicit Codex app-server controls

## Documentation

- [Chat bridge](docs/chat-bridge.md) · [Chat configuration](examples/chat.json)
- [Nerve events](docs/nerve.md) · [Event configuration](examples/nerve.json)
- [Architecture](docs/architecture.md) · [Validation](docs/validation.md)

## Development

```sh
npm ci
npm test
```

The repository is GPL-3.0-only.
