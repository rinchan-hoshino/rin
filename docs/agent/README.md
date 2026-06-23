# Rin Agent Docs

This directory is the source for Rin-installed agent guidance. It is installed as `~/.rin/docs/rin/` and is written for agents operating inside Rin, not for end-user README content or developer-maintainer notes.

## Authority

Use these docs as the Rin-specific layer above upstream Pi docs.

- For Rin runtime behavior, launcher layout, daemon behavior, memory, scheduled tasks, chat bridge behavior, builtin extensions, and other Rin-owned features, read Rin docs first.
- Use upstream Pi docs as the base reference for topics not covered by Rin.
- When Rin docs and Pi docs conflict on Rin behavior, Rin docs take precedence.

## Reading path

1. Start here.
2. Read `docs/execution-environment.md` to identify the live runtime, loop boundary, tools, paths, and environment ownership.
3. Read `docs/pi-overrides.md` before relying on upstream Pi docs.
4. Read the narrow topic document for the task.
5. Read a practice page only when the task needs browser or desktop operation.
6. Consult upstream Pi docs only for uncovered topics, with Rin overrides applied.

## Topic map

- `docs/execution-environment.md`: agent runtime, loop boundary, environment inspection, self-improvement surfaces, and user-environment ownership.
- `docs/pi-overrides.md`: how Rin changes interpretation of upstream Pi docs.
- `docs/session-awareness.md`: inspecting active/recent sessions, processes, worktrees, chat turns, and scheduled/background tasks.
- `docs/diagnostic-commands.md`: using `doctor`, `status`, `usage`, and `self-improve` frontend/backend surfaces.
- `docs/non-interactive-cli.md`: spawning isolated delegated child runs with managed sessions.
- `docs/runtime-layout.md`: stable paths, launcher ownership, app releases, and paths safe for agents to reference.
- `docs/capabilities.md`: compact behavior and conventions for Rin agent-facing features.
- `docs/builtin-extensions.md`: builtin and bundled optional capabilities provided by Rin core.
- `docs/memory-layering.md`: choosing between memory evidence/retrieval and distilled self-improve guidance.
- `docs/self-improve-distillation.md`: prompt-engineering contract for self-improve distillation passes.
- `docs/initialization.md`: initialization flow for durable user and assistant preferences.
- `docs/agent-sdk.md`: local SDK helpers for daemon-backed task and chat operations.
- `docs/scheduled-tasks.md`: scheduled task creation, inspection, update, deletion, and verification.
- `docs/chat-bridge.md`: chat bridge SDK/configuration workflows, stored chat paths, and adapter notes.
- `docs/rich-text-output-format.md`: native mentions, quotes/replies, attachments, files/images, and fallback syntax.
- `practices/README.md`: route browser, computer, mobile, and search work to the current practice pages.
- `practices/browser/README.md`: browser operation using the owner's external browser workflow.
- `practices/computer/README.md`: desktop operation patterns for Linux, Windows, macOS, and local/remote work.
- `practices/mobile/README.md`: mobile operation patterns.
- `practices/search/README.md`: web search patterns, including direct Google URLs and optional SearXNG.

## Source and installed locations

- Installed Rin agent docs: `~/.rin/docs/rin/`.
- Installed Rin builtin skills: `~/.rin/docs/rin/builtin-skills/`.
- Installed upstream Pi reference docs: `~/.rin/docs/pi/`.
- Source for this installed doc set: `docs/agent/`.
- Source for Rin-owned installed builtin skills: `docs/agent/builtin-skills/`.
- Developer-only architecture, testing, GUI, and release workflow docs live in repository `docs/developer/` and are not installed as agent guidance.
