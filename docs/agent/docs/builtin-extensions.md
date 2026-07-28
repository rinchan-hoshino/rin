# Builtin Extensions and Capability Sources

Use this page to identify where a Rin capability comes from: native Rin core, live third-party tool, practice document, or Rin background extension runtime. For task-level usage, start with `docs/capabilities.md`.

The live tool list remains authoritative for the current turn.

## Capability source map

| Source                                   | Provides                                                                                                                                                                            | Configuration surface                                                                                         | Agent route                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Rin core                                 | runtime prompt assembly, memory, self-improve, message metadata, frozen session runtime, TUI compatibility, todo, scheduled-task SDK workflows, agent-owned chat setup, token usage | built into Rin                                                                                                | use live tools, CLI, SDK, or topic docs             |
| Browser/computer/mobile/search operation | browser, computer, mobile, or search tools supplied by the live runtime, plus documented practice patterns                                                                          | live tool list or external Pi extension config                                                                | read `practices/README.md`                          |
| Background extension runtime             | trusted long-running services, chat adapters, and external memory providers                                                                                                         | `settings.json -> rinExtensions.backgroundServices` or trusted extension entries with background capabilities | inspect runtime state and relevant extension config |

## Rin core capabilities

These capabilities are native Rin behavior rather than optional Pi extensions:

- `memory`: `recall`, transcript archiving, and searchable session-history index.
- `self-improve`: compact distilled guidance in prompt baselines, agent-managed skills, periodic review, and hidden nightly consolidation.
- system prompt assembly: Rin default stance, tool guidance, configured baselines, and available skill metadata.
- message metadata: `sent at` and chat-specific prompt context when applicable.
- frozen session runtime: stable effective system prompt within a session until refresh or reload.
- TUI input compatibility: Rin-owned compatibility handling for interactive input.
- todo: `todo` tool and `/todos` command.
- task: scheduled task workflows through the local Rin Agent SDK.
- chat: agent-owned adapter setup, SDK/file workflows, stored-message lookup, and identity/trust data paths.
- token usage: telemetry under `~/.rin/data/core/usage/usage.db` and the `rin usage` dashboard.

Read the topic document for the capability before operating it:

- memory and self-improve: `docs/memory-layering.md`, `docs/self-improve-distillation.md`.
- scheduled tasks: `docs/agent-sdk.md`, `docs/scheduled-tasks.md`.
- chat: `docs/chat-bridge.md`, `docs/rich-text-output-format.md`.
- delegated child runs: `docs/non-interactive-cli.md`.

## Core todo

Rin core always provides todo support. It registers:

- `todo`: current-branch execution checklist tool.
- `/todos`: interactive TUI command for the current checklist.

Todo state is checkpointed in Pi session custom entries and reconstructed from the current session branch, so forks and session branches can recover the matching checklist without relying on context-visible tool-result details or compaction summaries. In daemon/RPC chat turns, Rin may continue hidden work when a final answer appears while todo items remain incomplete; hidden continuations end when todos complete, when todo state stops changing, or after the continuation limit.

## Bundled foreground extensions

Rin currently ships no bundled optional foreground extensions. Existing installs that still contain removed bundled aliases such as `rin:browse` have those entries stripped during install/update settings persistence.

Use ordinary Pi extension configuration for trusted third-party foreground extensions. Use the live tool list as the source of truth for which tools are available in the current turn.

## Browser, computer, mobile, and search operation

Browser, desktop, mobile, and search tools are live-runtime capabilities. Use them when they appear in the live tool list.

Use practice docs for current owner workflow routing and setup guidance:

- route map: `practices/README.md`.
- browser operation: `practices/browser/README.md`.
- desktop operation: `practices/computer/README.md`.
- mobile operation: `practices/mobile/README.md`.
- search operation: `practices/search/README.md`.

Trusted third-party Pi extensions for browser or computer control are configured through normal Pi extension rules as explicit extension paths or packages.

## Background extensions

Background extensions run in Rin's background runtime as trusted Node.js packages. They are used for long-running async services, chat adapters, and external memory providers.

Configuration sources:

- `settings.json -> rinExtensions.backgroundServices`;
- trusted local/package extension entries that expose background capabilities.

Background services may install or update configured npm packages under `~/.rin/data/extensions/runtime` during startup. Restart or reload Rin after editing background extension settings.

Background extensions can register:

- chat adapters with `ctx.registerChatAdapter(...)`;
- external memory providers with `ctx.registerMemoryProvider(...)`.

Memory providers may implement `search`, `listRecent`, and `write`, select `append` or capability-scoped `replace`, and return remote `reference` or `url` values. Native local memory remains a core implementation; the internal coordinator composes it with extension adapters. Use `apiVersion: 1` and read `docs/memory-provider-api.md` for the complete contract.

Keep normal built-in chat adapter configuration under `settings.json -> chat`. Use background services for intentionally configured background event bridges, custom chat adapters, or trusted external memory backends.
