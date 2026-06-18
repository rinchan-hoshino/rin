# Agent-facing Capabilities

Use this page as Rin's capability index. It tells agents what runtime surfaces exist, when they matter, and which topic document to read next. Use the live tool list and current system prompt as the source of truth for the current turn.

## Capability index

| Capability                    | Use when                                                                                                                      | Entry point                                                | Read next                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| Rin launcher                  | Starting, status checks, update, rollback, or installed-runtime maintenance                                                   | `rin`, `rin status`, `rin update --yes`, `rin rollback`    | `docs/runtime-layout.md`                                       |
| Runtime status and usage      | Checking daemon activity, workers, scheduled tasks, or token telemetry                                                        | `rin status`, `rin status --json`, `rin usage`             | `docs/execution-environment.md`, `docs/runtime-layout.md`      |
| Memory and self-improve       | Choosing between original evidence/retrieval and distilled reusable guidance                                                  | `recall`, prompt baselines, skills                         | `docs/memory-layering.md`, `docs/self-improve-distillation.md` |
| Non-interactive child runs    | Isolated scouting, review, verification, comparison, or bounded draft work                                                    | `rin -p`, `--mode json`, `--managed-session`               | `docs/non-interactive-cli.md`, `docs/session-awareness.md`     |
| Scheduled tasks               | Reminders, delayed follow-ups, recurring checks, conditional automation, or work after the current turn                       | Rin Agent SDK `rin.tasks.*`                                | `docs/agent-sdk.md`, `docs/scheduled-tasks.md`                 |
| Chat bridge                   | Agent-owned chat adapter setup, outbound chat operations, stored chat inspection, identity/trust data, or detached chat turns | `settings.json -> chat`, Rin Agent SDK, chat message store | `docs/chat-bridge.md`, `docs/rich-text-output-format.md`       |
| Todo                          | Current-branch execution checklist during multi-step work                                                                     | `todo` tool, `/todos`                                      | live tool schema                                               |
| Browse                        | Current, external, source-dependent, or version-sensitive web evidence; direct HTTP(S) page fetch                             | `browse`, `rin:browse` extension                           | `docs/builtin-extensions.md`                                   |
| Browser and desktop operation | Web or desktop work when a live browser/computer tool is present, or a task needs documented manual automation patterns       | live tool list, practice docs                              | `practices/browser-use.md`, `practices/computer-use.md`        |
| Background extensions         | Trusted long-running async extensions or external event/memory providers                                                      | `settings.json -> rinExtensions.backgroundServices`        | `docs/builtin-extensions.md`                                   |
| Initialization                | Owner asks to initialize, reset, or establish preferences                                                                     | initialization prompt flow                                 | `docs/initialization.md`                                       |

## Launcher, update, and rollback

Use the `rin` launcher as the installed-runtime entrypoint.

- `rin`: normal interactive launch.
- `rin status` / `rin status --json`: daemon, worker, and scheduled-task state.
- `rin usage`: token telemetry and usage dashboard.
- `rin update --yes`: the only agent-facing installed-runtime update command.
- `rin rollback`: switch to the `previousRelease` recorded in the install manifest.

Use `docs/runtime-layout.md` to audit launcher ownership, `installDir`, manifests, services, `app/current`, and release directories. Source checkout maintenance and installed-runtime maintenance are different surfaces.

Before update or rollback, verify target ownership through the installed manifests or service files. After update or rollback, verify `app/current/`, release metadata, and `rin status` when daemon liveness matters.

## Memory and self-improve

Rin separates memory from self-improve:

- memory preserves original evidence and supports retrieval through archived transcripts, memory indexes, and `recall`;
- self-improve stores distilled guidance in prompt baselines, reusable skills, and short-term continuity records.

Read `docs/memory-layering.md` before choosing a destination. Read `docs/self-improve-distillation.md` before running or editing self-improve distillation prompts.

## Core todo and bundled browse

The core todo capability registers the `todo` tool and `/todos` command from Rin core. Use it for current-branch execution checklists when the live tool list includes `todo`.

Rin ships `rin:browse` as the bundled optional foreground Pi extension alias:

```json
{
  "extensions": ["rin:browse"]
}
```

`rin:browse` registers `browse`. Search mode uses Rin-managed SearXNG; URL mode fetches readable content from a specific HTTP(S) page. Fresh installs enable the alias by default unless installer selection disables it. Existing installs follow their current `settings.json -> extensions` value.

Use Pi resource filters such as `!rin:browse` to disable the alias from a broader extension list.

## Chat bridge

Rin's direct built-in chat bridge currently includes Telegram, OneBot, QQ, Feishu / Lark, Discord, Slack, and Minecraft / QueQiao.

Use `docs/chat-bridge.md` for:

- agent-owned `settings.json -> chat` adapter setup;
- SDK-backed chat sending and detached chat turns;
- stored message lookup;
- identity/trust data updates;
- adapter-specific files, logs, and operation notes.

Use `docs/rich-text-output-format.md` for native mentions, quotes/replies, attachments, files/images, and fallback syntax.

## Background extensions

Background extensions are trusted Node.js packages loaded by Rin's background runtime for long-running async work. They are configured through `settings.json -> rinExtensions.backgroundServices` or discovered from trusted Rin/Pi extension entries that expose background capabilities.

Use them for intentionally configured background event bridges, chat adapters, or memory providers. Restart or reload Rin after changing background extension settings.

## Browser and computer operation

Use browser or desktop automation tools from the live tool list when they are present. Use the practice docs for documented manual or tool-specific patterns:

- `practices/browser-use.md`
- `practices/computer-use.md`

## Stable documentation paths

Prefer stable installed doc paths in agent guidance:

- `~/.rin/docs/rin/`: Rin-specific agent docs.
- `~/.rin/docs/pi/`: installed upstream Pi docs.
- `~/.rin/docs/release/`: release-note metadata used by `/changelog`.
