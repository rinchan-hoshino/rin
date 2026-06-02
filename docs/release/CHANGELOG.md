# Rin Changelog

## 0.3.0

- Rin keeps prompt context more reliably across chat, TUI, CLI, and provider turns: compaction budgeting is unified, stale tool-result history is pruned safely, and recent turns remain protected while context is rebuilt.
- Chat sessions recover more cleanly around new sessions, aborted turns, and reconnects, including completing chat turns from the active session branch instead of drifting to stale state.
- Scheduled one-shot tasks that reschedule themselves now keep their next run instead of being marked completed too early, and scheduled-task session-mode guidance is clearer for agents.
- Pi integration is stricter and easier to maintain: startup tool options now propagate through Rin entrypoints, Pi-facing seams are centralized, and built-in extension loading follows the shared bridge path.
- Rin can launch managed non-interactive CLI subagent sessions for bounded scout, review, and verification work.
- Browser/computer-use built-ins were removed from the Rin source distribution so account/browser work stays on the current VM-owned workflow boundary.
- README and localized package metadata now include the RinChan Ko-fi support link.

## 0.2.0

- Chat bridges are more reliable across restarts and transient failures: bound chat sessions keep their session files, inbox recovery avoids duplicate or stale turns, and command acknowledgements no longer start normal assistant turns.
- Scheduled tasks now support manual run-now execution, current-session routing, clearer task prompt guidance, and safer session shutdown behavior.
- TUI and RPC status handling is smoother: startup/update checks run in the background, compaction and reconnect status are rendered with stable loaders, todo checklist output is polished, and command output uses Rin i18n strings consistently.
- Runtime compaction and continuation handling is safer: overflow compaction keeps turns alive, failed or interrupted turns preserve prompt context, and stale worker/session recovery is less likely to lose state.
- Web search is more resilient on Google-backed direct search, including clearer challenge recovery guidance and shared Google request pacing across Rin workers.
- Installer and update flows preserve target-user language/settings more consistently, record explicit rollback release metadata, wait longer for daemon readiness, and keep installer manifests focused on install/release state.
- Self-improve and memory maintenance are cleaner: memory review paths, external memory-provider support, memory triggers, generated summary cleanup, and skill/document layout were tightened.
- User-facing errors and startup/help copy now avoid leaking internal runtime markers and present clearer Rin-branded guidance.

## 0.1.0

- Rin TUI update notices now use Rin release metadata and link to Rin release notes instead of Pi update feeds.
- `/changelog` now displays Rin-native release notes from `docs/release/CHANGELOG.md`.
- Beta, stable, and hotfix release workflows now verify that Rin changelog notes exist for the user-facing release version before publishing metadata.

## 0.0.0

- Start tracking Rin-native release notes under `docs/release/CHANGELOG.md`.
- Install and update now resolve release channels through `release-manifest.json`.
- Stable is the default channel and is intended to resolve through npm release metadata.
- Beta remains an explicit opt-in channel backed by GitHub release-train branches.
