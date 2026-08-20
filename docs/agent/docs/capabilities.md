# Agent-facing Capabilities

Use this page as Rin's capability index. It tells agents what runtime surfaces exist, when they matter, and which topic document to read next. Use the live tool list and current system prompt as the source of truth for the current turn.

## Capability index

| Capability                               | Use when                                                                                                                  | Entry point                                                | Read next                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------- |
| Rin launcher                             | Starting, status checks, update, rollback, or installed-runtime maintenance                                               | `rin`, `rin doctor`, `rin update`, `rin rollback`          | `docs/runtime-layout.md`                                 |
| Runtime status                           | Checking daemon health, session activity, or self-improve history                                                         | `rin doctor`, `rin status`, `rin self-improve`             | `docs/diagnostic-commands.md`, `docs/runtime-layout.md`  |
| Memory and self-improve                  | Choosing between original evidence/retrieval and distilled reusable guidance                                              | `recall`, `rin self-improve`, prompt baselines, skills     | `docs/memory-layering.md`                                |
| Non-interactive child runs               | Isolated scouting, review, verification, comparison, or bounded draft work                                                | `rin -p`, `--mode json`, `--managed-session`               | `docs/non-interactive-cli.md`                            |
| Scheduled tasks                          | Reminders, delayed follow-ups, recurring checks, conditional automation, or work after the current turn                   | Rin Agent SDK `rin.tasks.*`                                | `docs/agent-sdk.md`, `docs/scheduled-tasks.md`           |
| Chat                                     | Agent-owned platform setup, outbound chat operations, stored chat inspection, identity/trust data, or detached chat turns | `settings.json -> chat`, Rin Agent SDK, chat message store | `docs/chat-bridge.md`, `docs/rich-text-output-format.md` |
| Todo                                     | Current-branch execution checklist during multi-step work                                                                 | `todo` tool, `/todos`                                      | live tool schema                                         |
| Browser/computer/mobile/search operation | Web, desktop, mobile, or search work supported by the current runtime                                                     | live tool list                                             | live tool schema                                         |
| Extensions                               | Pi-native session extensions plus optional trusted Chat platforms                                                         | ordinary Pi extension/package configuration                | `docs/extensions.md`                                     |
| Initialization                           | Owner asks to initialize, reset, or establish preferences                                                                 | initialization prompt flow                                 | `docs/initialization.md`                                 |

## Launcher, update, and rollback

Use the `rin` launcher as the installed-runtime entrypoint.

- `rin`: normal interactive launch.
- `rin doctor` / `rin doctor --json`: whole-runtime health and service logs.
- `rin status` / `rin status --json`: session work state and daemon activity.
- optional `/usage` extension: Codex quota only, with no core telemetry or chart.
- `rin self-improve`: recent and historical self-improve outcomes.
- `rin update`: the only installed-runtime update command. Interactive terminal callers can use bare `rin update`; non-interactive callers must add `--yes`, or the launcher fails before accepting an update job. Channel selection is flag-based: use `rin update --git main` for the `main` branch, and add `--yes` when calling it non-interactively. `--branch` remains legacy compatibility, not the canonical selector. It reinstalls the resolved target even when that exact release is already current, so damaged managed runtime files are restored without replacing the prior rollback release. Every accepted invocation creates the same updater-owned job record and runs the same update-job executor. Terminal updates keep interactive I/O through that executor; daemon-owned updates host it in a transient systemd service, temporary LaunchAgent, or detached Windows process. The private payload accepts only its running executor-owned job. The installer entrypoint translates the retired `main.js --update` prepared handoff into that same payload only when the old updater supplies its complete preconfirmed arguments from the canonical `work-*/src` and sibling `release.json` workspace.
- `rin rollback`: switch to the `previousRelease` recorded in the install manifest.

Use `docs/runtime-layout.md` to audit launcher ownership, agent directory, manifests, services, `app/current`, and release directories. Source checkout maintenance and installed-runtime maintenance are different surfaces.

Before update or rollback, verify target ownership through the installed manifests or service files. After update or rollback, verify `app/current/`, release metadata, and `rin status` when daemon liveness matters.

## Memory and self-improve

Rin separates memory from self-improve:

- memory preserves original evidence and supports retrieval through archived transcripts, memory indexes, and `recall`;
- self-improve stores distilled guidance in prompt baselines, reusable skills, and short-term continuity records.

Read `docs/memory-layering.md` before choosing a destination. The built-in self-improve review prompt contains the complete editing guidance. Use `rin self-improve`, not `rin memory`, when inspecting self-evolution history.

## Core todo

The core todo capability registers the `todo` tool and `/todos` command from Rin core. It stores the checklist as session-branch items without copying it into compaction summaries; agents read it through the tool when needed. Its operations are `read`, `add`, `edit`, `remove`, `toggle`, and `clear`: read and every mutation use the same dense current-order numbering `1..n`, with the first item always numbered `1`; reads return the complete list by default or a positional item range with 1-based `offset` and positive `limit`; adds accept one or more items and optional `beforeId`; edits replace the text of exactly one current `id`; removals target one or more current `ids`; toggles atomically change the completion state of one or more selected current `ids`; insertion and removal immediately renumber the returned list; clear removes every item.

## Compaction summary policy

Rin owns one complete Hermes-style continuation-checkpoint prompt while reusing Pi's model, authentication, retry, preparation, and file-detail pipeline. Pi's native summary prompt is not prepended. The checkpoint preserves the historical task snapshot, goal, active constraints, concrete completed actions, live state, blockers, decisions, errors and fixes, resolved questions, relevant files, and critical operational details. Its target budget scales with the compacted source and is guidance rather than a hard output cap. When Pi selects a cut inside one tool-using turn, Rin summarizes the older history and the cut turn prefix together in one chronological pass. Todo remains tool-owned branch state and is not copied into the checkpoint.

## Chat bridge

Rin's core Chat capability includes Telegram and Discord platform implementations. OneBot and Feishu / Lark are installed separately as ordinary Pi extensions.

Use `docs/chat-bridge.md` for:

- agent-owned `settings.json -> chat` platform setup;
- SDK-backed chat sending and detached chat turns;
- stored message lookup;
- identity/trust data updates;
- adapter-specific files, logs, and operation notes.

Use `docs/rich-text-output-format.md` for native mentions, quotes/replies, attachments, files/images, and fallback syntax.

## Optional Chat platform extensions

Optional Chat platforms are trusted ordinary Pi extensions discovered by the native loader. Their default factory contributes a narrow platform implementation through Pi events; Rin has no separate daemon extension factory or loader.

Use them for intentionally configured external Chat platforms. Restart or reload Rin after changing platform extension settings.

## Browser, computer, mobile, and search operation

Use browser, desktop, mobile, or search tools only when they are present in the live tool list, and follow their current tool schemas.

## Stable documentation paths

Prefer stable installed doc paths in agent guidance:

- `~/.rin/docs/rin/`: Rin-specific agent docs.
- `~/.rin/docs/pi/`: installed upstream Pi docs.
- `~/.rin/docs/release/`: release-note metadata used by `/changelog`.
