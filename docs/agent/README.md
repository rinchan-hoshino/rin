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
- `practices/`: recommended operating practices for environment-specific work.
- `builtin-skills/`: Rin-owned builtin skills installed under `~/.rin/docs/rin/builtin-skills/`.

Developer-only architecture, testing, GUI, and release workflow documentation lives in `docs/developer/` in the repository source and is not installed as agent guidance.

## Start here

- `docs/execution-environment.md`: agent identity, agent loop, environment inspection, self-improvement memory, and user-environment boundaries.
- `docs/session-awareness.md`: how to inspect what other sessions, processes, and scheduled/background tasks did recently or are doing now.
- `docs/pi-overrides.md`: how to interpret upstream Pi docs inside Rin, including where Rin changes the meaning.

## Topic entrypoints

- `docs/execution-environment.md`: how to understand the current agent runtime and what to verify before acting.
- `docs/session-awareness.md`: how to avoid racing parallel sessions by checking active/recent Rin sessions, processes, worktrees, and background tasks.
- `docs/non-interactive-cli.md`: how to spawn isolated delegated child runs with managed sessions.
- `docs/runtime-layout.md`: runtime layout, stable paths, launcher ownership, and paths safe for agents to reference.
- `docs/builtin-extensions.md`: builtin capabilities and default extra capabilities provided by Rin core.
- `docs/capabilities.md`: compact agent-facing behavior and conventions for Rin features.
- `docs/memory-layering.md`: how to choose between always-on prompt baselines, skills, and transcript memory.
- `docs/self-improve-memory-maintenance.md`: shared requirements for self-improve review and consolidation prompts.
- `docs/agent-sdk.md`: local SDK helpers for daemon-backed task and chat operations that agents should not perform through raw RPC payloads.
- `docs/scheduled-tasks.md`: scheduled task creation, inspection, update, deletion, and verification workflows.
- `docs/chat-bridge.md`: chat bridge SDK/configuration workflows, stored chat paths, and adapter notes.
- `docs/rich-text-output-format.md`: native mention, quote, attachment, and fallback syntax for rich outputs.
- `practices/`: practice index for environment-specific work.
- `practices/browser-use.md`: browser automation patterns for headless/headful and local/remote work.
- `practices/computer-use.md`: desktop automation patterns for Linux, Windows, macOS, and local/remote work.

## Reading order

1. Start with `README.md`.
2. Read `docs/execution-environment.md` to understand the current agent runtime and loop.
3. Read `docs/pi-overrides.md` before relying on upstream Pi docs.
4. Read the relevant topic entrypoint in `docs/`.
5. Read the relevant practice page in `practices/` when the task needs browser or desktop operation.
6. Consult upstream Pi docs only as needed.

## Notes

- Installed Rin agent docs: `~/.rin/docs/rin/`.
- Installed Rin builtin skills: `~/.rin/docs/rin/builtin-skills/`.
- Installed upstream Pi reference docs: `~/.rin/docs/pi/`.
- Repository source for this installed doc set: `docs/agent/`.
- Repository source for installed builtin skills: Rin-owned skills under `docs/agent/builtin-skills/`, plus selected external mirrors such as `upstream/skill-creator/`.
