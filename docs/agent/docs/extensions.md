# Extensions and Capability Sources

Use this page to distinguish native Rin core capabilities from Pi extensions and Rin's frontend/backend adapters. For task-level usage, start with `docs/capabilities.md`.

The live tool list remains authoritative for the current turn.

## Capability source map

| Source                                   | Provides                                                                                                                                                               | Configuration surface                                       | Agent route                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| Rin core                                 | runtime prompt assembly, memory, self-improve, message metadata, frozen session runtime, TUI compatibility, todo, scheduled-task SDK workflows, agent-owned chat setup | built into Rin                                              | use live tools, CLI, SDK, or topic docs         |
| Browser/computer/mobile/search operation | browser, computer, mobile, or search tools supplied by the live runtime                                                                                                | live tool list or external Pi extension config              | follow the live tool schema                     |
| Optional Chat platform extension         | trusted external Chat platform implementations                                                                                                                         | ordinary Pi extension entries using the Chat platform event | inspect Chat state and relevant platform config |

## Rin core capabilities

These capabilities are native Rin behavior rather than optional Pi extensions:

- `memory`: `recall`, transcript archiving, and searchable session-history index.
- `self-improve`: compact distilled guidance in prompt baselines, agent-managed skills, periodic review, and hidden nightly consolidation.
- system prompt assembly: Rin default stance, tool guidance, configured baselines, available skill metadata, and the load-scoped chat/task binding supplied before first materialization.
- message metadata: turn-local `sent at`, sender, trust, file, and reply context stays with the current user input.
- frozen session runtime: the complete effective system prompt has one durable owner and remains byte-stable through ordinary turns and group-name changes. Explicit reload and successful compaction refresh materialize and persist a fresh prompt. The first prompt after 25 hours without session activity attempts one compaction first and continues whether that attempt succeeds or fails.
- TUI input compatibility: Rin-owned compatibility handling for interactive input.
- todo: `todo` tool and `/todos` command.
- task: scheduled task workflows through the local Rin Agent SDK.
- chat: agent-owned platform setup, SDK/file workflows, stored-message lookup, and identity/trust data paths.

Read the topic document for the capability before operating it:

- memory and self-improve: `docs/memory-layering.md`, `docs/self-improve-distillation.md`.
- scheduled tasks: `docs/agent-sdk.md`, `docs/scheduled-tasks.md`.
- chat: `docs/chat-bridge.md`, `docs/rich-text-output-format.md`.
- delegated child runs: `docs/non-interactive-cli.md`.

## Core todo

Rin core always provides todo support. It registers:

- `todo`: current-branch execution checklist tool.
- `/todos`: interactive TUI command for the current checklist.

Todo state is checkpointed in Pi session custom entries and reconstructed from the current session branch, so forks and session branches can recover the matching checklist without relying on context-visible tool-result details or compaction summaries. Rin does not copy the checklist into compaction summaries; agents read it through the tool when needed. The tool exposes item-level `read`, `add`, `edit`, `remove`, `toggle`, and `clear`; read and every mutation use the same dense current-order numbering `1..n`, with the first item always numbered `1`. Reads return the full list by default or accept a 1-based item `offset` and positive `limit`; adds can insert before a current number; edits change text only; removals and toggles atomically target one or more current numbers; insertion and removal immediately renumber the returned list; clear removes every item. In daemon/RPC chat turns, Rin may continue hidden work when a final answer appears while todo items remain incomplete; hidden continuations end when todos complete, when todo state stops changing, or after the continuation limit.

## Extension loading

Rin has no separate built-in-extension registry or foreground extension loader. It uses Pi's native `DefaultResourceLoader`, adds Pi's own inline extensions, and applies frontend/backend compatibility adapters around the resulting extension set.

Use ordinary Pi extension configuration for trusted third-party extensions. Use the live tool list as the source of truth for which tools are available in the current turn.

## Extension commands in the Rin CLI

When a top-level word is not a Rin or Pi management command, Rin loads the same Pi package set and resolves a matching extension slash command. Therefore an extension command registered as `/usage` is also available as `rin usage ...`; terminal output is collected from Pi's native `ctx.ui.notify(...)`. `rin --help` discovers those registered commands and lists them as extension-provided subcommands. Rin does not maintain a second CLI command registry for packages. For a saved cross-user install, Pi and extension subcommands are delegated to the target user's Rin CLI before discovery so packages, credentials, and extension data resolve from the target runtime instead of the invoking user's home.

Rin also adds `ctx.rin.agentDir` and `ctx.rin.frontendIdentity` to extension lifecycle and command contexts. Use `RinExtensionContext` from `@hoshinorin/rin/extension` for the canonical type. The metadata belongs to Rin's context adapter and replaces reads of private session-manager fields or deployment paths.

## Cross-frontend command results

Pi's native `ctx.ui.notify(...)` remains the portable text-notification path. Rin adds one optional command-result method to the same UI context when the frontend can deliver rich output:

```ts
ctx.ui.rinCommandResult?.({
  fallbackText: "Codex usage: 5-hour 80% left",
  parts: [
    {
      type: "image",
      path: "/absolute/path/to/card.png",
      mimeType: "image/png",
    },
  ],
});
```

Use `RinExtensionCommandContext`, `RinExtensionCommandResult`, and `RinExtensionUIContext` from `@hoshinorin/rin/extension` for the canonical types. `text` and `parts` are delivered together by Chat; `fallbackText` is used by terminal frontends that cannot display the rich parts. If `rinCommandResult` is absent, the extension is running under a frontend or plain Pi runtime without Rin rich-result support and should use the native Pi text presentation appropriate for that frontend.

This is a command-result channel, not an out-of-band notification API. Local media paths must exist until Chat has accepted the result; Chat validates and copies/delivers them through its normal outbox boundary.

## Command presentation and Working copy

Pi's native `ctx.ui.setWorkingMessage(...)` owns the current Working copy. Rin also exposes an optional generic command-response setter:

```ts
const ui = ctx.ui as RinExtensionUIContext;
ui.setCommandResponses?.({
  compactionStart: "Compacting...",
  compactionSummaryLine: "Compacted from {tokens} tokens",
});
ctx.ui.setWorkingMessage("Working...");
```

Each call replaces the previous extension response settings while preserving the frontend baseline for omitted fields. This API contains no locale selection, translation keys, or catalog behavior; an extension may use it for any presentation policy. A plain Pi frontend may omit `setCommandResponses`; `setWorkingMessage` remains Pi-native.

## Browser, computer, mobile, and search operation

Browser, desktop, mobile, and search tools are live-runtime capabilities. Use them when they appear in the live tool list and follow their current schemas.

Trusted third-party Pi extensions for browser or computer control are configured through normal Pi extension rules as explicit extension paths or packages.

First-party optional extensions, including Codex-only `/usage` and self-improve result reminders, live in `rinchan-hoshino/rin-extensions` rather than Rin core.

## Optional Chat platform extensions

Telegram and Discord are Chat-owned core platform implementations. Other trusted platforms may be ordinary Pi extensions discovered by `DefaultResourceLoader`.

An optional platform extension keeps Pi's standard default factory and emits one `rin.chat.platform.v1` contribution through `pi.events`. The contribution receives only the narrow platform context exported by `@hoshinorin/rin/extension`; Chat retains lifecycle, database, inbox/outbox, binding, and recovery ownership. There is no separate daemon extension API, loader, registry, or package format.

Install and update packages through Pi package commands exposed by the `rin` CLI. Keep each platform's account configuration under `settings.json -> chat`, and restart or reload Rin after changing extension settings.
