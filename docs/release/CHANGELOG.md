# Rin Changelog

## 0.5.0

- Chat and daemon recovery is more resilient: active submitted turns stay attached during recovery, passive notices target the right chat session, replaced resume workers shut down cleanly, and outbox delivery stalls are isolated from other chat traffic.
- Provider and compact-command failures now surface more accurately, including retry-exhaustion details without extra compact acknowledgements.
- The todo tool can now read the current checklist when called without replacement data, matching the documented checklist workflow.
- Installer and update flows are clearer and safer around update progress, cleanup, and CLI handoff behavior.
- Self-improve review and distillation paths now require eligible producers and prefer target-state guidance, reducing stale or unsupported review output.
- Release executors now verify changelog coverage against included commits before publishing stable or prerelease metadata.

<!-- rin-changelog-coverage
cd8c892 fix(release): require changelog commit coverage
e336177 fix: suppress compact chat acknowledgement
fb0f678 fix(chat): keep submitted turns alive during active recovery
ccc4718 fix(chat): bind passive notices to chat sessions
0fdd7ee fix(chat): show retry exhaustion in provider errors
3738ddb feat(todo): read checklist when todos is omitted
1e44a32 fix(daemon): shut down replaced resume sessions
198f1a6 fix(chat): preserve retry exhaustion on thrown provider errors
b587d6e fix(chat): isolate outbox delivery stalls
a961138 Refine Rin update installer flow
ea1dccf docs(self-improve): prefer target-state distillation
ff4bde6 fix(self-improve): require eligible producers for reviews
-->

## 0.4.0

- Chat and daemon sessions reuse workers more safely across reconnects, session switches, and restored turns, so frontends are less likely to attach to stale or duplicate session state.
- Chat bridge delivery is more reliable for reply-bound steering and control messages: visible processing replies can be retargeted, restored provider errors are completed cleanly, and cross-user `rin` commands keep the right install metadata.
- OneBot/NapCat media sending now stages local media through Rin's chat-media area and reports clearer Docker mount guidance when NapCat cannot read a file.
- GitHub-backed beta, nightly, and git updates now prefer codeload archives, and release executors can run candidate metadata/bootstrap scripts without relying on preinstalled local dependencies.

## 0.3.0

- Rin keeps prompt context more reliably across chat, TUI, CLI, and provider turns: compaction budgeting is unified, stale tool-result history is pruned safely, and recent turns remain protected while context is rebuilt.
- Chat sessions recover more cleanly around new sessions, aborted turns, and reconnects, including completing chat turns from the active session branch instead of drifting to stale state.
- Scheduled one-shot tasks that reschedule themselves now keep their next run instead of being marked completed too early, and scheduled-task session-mode guidance is clearer for agents.
- Pi integration is stricter and easier to maintain: startup tool options now propagate through Rin entrypoints, Pi-facing seams are centralized, and built-in extension loading follows the shared bridge path.
- Rin can launch managed non-interactive CLI subagent sessions for bounded scout, review, and verification work.
- `rin self` now shows self-improve distillation history without the old `rin memory` command alias or longer `rin self-improve` entrypoint.
- Browser/computer-use built-ins were removed from the Rin source distribution so account/browser work stays on the current VM-owned workflow boundary.
- README and localized package metadata now include the RinChan Ko-fi support link.

## 0.2.0

- Chat bridges are more reliable across restarts and transient failures: bound chat sessions keep their session files, inbox recovery avoids duplicate or stale turns, and command acknowledgements no longer start normal assistant turns.
- Scheduled tasks now support manual run-now execution, current-session routing, clearer task prompt guidance, and safer session shutdown behavior.
- TUI and RPC status handling is smoother: startup/update checks run in the background, compaction and reconnect status are rendered with stable loaders, todo checklist output is polished, and command output uses Rin i18n strings consistently.
- Runtime compaction and continuation handling is safer: overflow compaction keeps turns alive, failed or interrupted turns preserve prompt context, and stale worker/session recovery is less likely to lose state.
- Browse is more resilient on Google-backed direct search, including clearer challenge recovery guidance and shared Google request pacing across Rin workers.
- Installer and update flows preserve target-user language/settings more consistently, record explicit rollback release metadata, wait longer for daemon readiness, and keep installer manifests focused on install/release state.
- Self-improve distillation and memory retrieval are cleaner: distilled-guidance review paths, external memory-provider support, memory triggers, generated summary cleanup, and skill/document layout were tightened.
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
