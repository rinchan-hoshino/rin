# Rin Agent Docs

This directory is the source for Rin-installed agent guidance. It is installed as `~/.rin/docs/rin/` and is written for agents operating inside Rin, not for end-user README content or developer-maintainer notes.

## Authority

Use these docs as the Rin-specific layer above upstream Pi docs.

- For Rin runtime behavior, launcher layout, daemon behavior, memory, scheduled tasks, Chat behavior, optional platform extensions, and other Rin-owned features, read Rin docs first.
- Use upstream Pi docs as the base reference for topics not covered by Rin.
- When Rin docs and Pi docs conflict on Rin behavior, Rin docs take precedence.

## Reading path

1. Choose the narrow topic document for the task from the map below.
2. Read `docs/execution-environment.md` only when the live target or capability surface is unclear.
3. Read `docs/pi-overrides.md` only when upstream Pi behavior is relevant.
4. Read a practice page only when the task needs browser or desktop operation.
5. Consult upstream Pi docs only for uncovered topics, with Rin overrides applied.

## Topic map

- `docs/execution-environment.md`: agent runtime, loop boundary, environment inspection, self-improvement surfaces, and user-environment ownership.
- `docs/pi-overrides.md`: how Rin changes interpretation of upstream Pi docs.
- `docs/diagnostic-commands.md`: using `doctor`, `status`, and `self-improve` frontend/backend surfaces.
- `docs/non-interactive-cli.md`: spawning isolated delegated child runs with managed sessions.
- `docs/runtime-layout.md`: stable paths, launcher ownership, app releases, and paths safe for agents to reference.
- `docs/capabilities.md`: compact behavior and conventions for Rin agent-facing features.
- `docs/extensions.md`: Pi extension loading, optional Chat platform contributions, and core capability boundaries.
- `docs/memory-layering.md`: choosing between memory evidence/retrieval and distilled self-improve guidance.
- `docs/initialization.md`: initialization flow for durable user and assistant preferences.
- `docs/agent-sdk.md`: local SDK import, execution, and generic error handling.
- `docs/scheduled-tasks.md`: scheduled task creation, inspection, update, deletion, and verification.
- `docs/chat-bridge.md`: chat bridge SDK/configuration workflows, stored chat paths, and adapter notes.
- `docs/rich-text-output-format.md`: native mentions, quotes/replies, attachments, files/images, and fallback syntax.

## Source and installed locations

- Installed Rin agent docs: `~/.rin/docs/rin/`.
- Installed Rin builtin skills: `~/.rin/docs/rin/builtin-skills/`.
- Installed upstream Pi reference docs: `~/.rin/docs/pi/`.
- Source for this installed doc set: `docs/agent/`.
- Source for Rin-owned installed builtin skills: `docs/agent/builtin-skills/`.
- Developer-only architecture, testing, and release workflow docs live in repository `docs/developer/` and are not installed as agent guidance.
