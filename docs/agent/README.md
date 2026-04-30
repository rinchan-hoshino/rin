# Rin Agent Docs

These documents are for agents operating inside Rin. This source tree is `docs/agent/`, but the installer installs it as `~/.rin/docs/rin/`. It should not be mixed with user README content or developer-maintainer notes.

## Priority

For Rin-specific behavior, these docs sit above upstream Pi docs.

- Read Rin docs first when the task involves Rin behavior.
- Use upstream Pi docs as the base reference only when Rin docs do not cover the topic.
- If Rin docs and Pi docs conflict on Rin behavior, Rin docs take precedence.

## Structure

- `README.md`: entrypoint for Rin agent documentation.
- `docs/`: agent-facing topic docs and Rin-over-Pi override guides.

Developer-only architecture, testing, GUI, and release workflow documentation lives in `docs/developer/` in the repository source and is not installed as agent guidance.

## Start here

- `docs/execution-environment.md`: agent identity, agent loop, environment inspection, self-improvement memory, and user-environment boundaries.
- `docs/pi-overrides.md`: how to interpret upstream Pi docs inside Rin, including where Rin changes the meaning.

## Topic entrypoints

- `docs/execution-environment.md`: how to understand the current agent runtime and what to verify before acting.
- `docs/runtime-layout.md`: runtime layout, stable paths, launcher ownership, and paths safe for agents to reference.
- `docs/builtin-extensions.md`: builtin capabilities and default extra capabilities provided by Rin core.
- `docs/capabilities.md`: compact agent-facing behavior and conventions for Rin features.
- `docs/chat-bridge.md`: `chat_bridge` runtime objects, rich send examples, and adapter notes.

## Reading order

1. Start with `README.md`.
2. Read `docs/execution-environment.md` to understand the current agent runtime and loop.
3. Read `docs/pi-overrides.md` before relying on upstream Pi docs.
4. Read the relevant topic entrypoint in `docs/`.
5. Consult upstream Pi docs only as needed.

## Notes

- Installed Rin agent docs: `~/.rin/docs/rin/`.
- Installed upstream Pi reference docs: `~/.rin/docs/pi/`.
- Repository source for this installed set: `docs/agent/`.
