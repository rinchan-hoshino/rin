# Rin Changelog

## 0.7.0

- Chat integrations now use stricter bot-qualified chat keys, clearer slash-command surfaces, simpler Discord command acknowledgements, non-blocking platform acknowledgements, and channel-aware Discord metadata while retiring the Matrix adapter path.
- Prompt and self-improvement guidance now state the web-source, distillation, and conflict-closure rules more directly.
- Update notices and runtime usage diagnostics are clearer, including bare `rin update` wording and Pi-backed context token estimates.
- Daemon and scheduler recovery is more resilient across restarts, with persisted turn recovery, decoupled restart recovery, and worker-pool session continuations.
- Runtime and install paths are faster and safer, including CLI startup/dependency trimming, managed Node runtime bundles, managed-node update handoffs, launcher refreshes, PATH warnings, platform bundles without optional bundled extensions, and unresolved bootstrap git-ref handling.
- TUI and CLI session flows now handle resume listing, session rebind options, and non-interactive tool help more accurately.
- Chat recovery and Discord/QQ-style group handling are more reliable, including orphaned inbox reconciliation, accepted-inbox recovery, compact usage trend charts, and cached group member counts.
<!-- rin-changelog-coverage
ea07040 fix(release): tolerate absent bundled extensions
6bf9b52 fix(tui): index resume session listing
149fc38 fix(chat): cache group member counts
a150cb6 docs(self-improve): capture lessons and working style
befbab2 fix(cli): correct non-interactive tool help
3e8b3a7 fix(install): warn when shell PATH misses rin launcher
cbf3614 Revert "fix(install): source rin env after POSIX install"
dd17e9c fix(install): source rin env after POSIX install
3a29c5e fix(runtime): require managed node for handoffs
0232aa7 fix(update): prefer installed managed node for handoff
99aab35 refactor(chat): unify inbox recovery reconciliation
dbc22e8 fix(chat): restore orphaned accepted inbox items
7f97ced fix: refresh launchers during core updates
91e0d2a fix: apply managed runtime consistently
1b8e0f0 feat: ship managed Node runtime bundles
589aa22 fix(tui): forward session rebind options
5a91fbe feat(usage): render compact usage trend charts
25c29a2 fix(chat): acknowledge Discord interactions directly
370a0be fix(daemon): persist turn recovery in running workers
8dc83ff fix(self-improve): require conflict closure in distillation
389a47d fix(daemon): recover TUI turns after restart
fc4bb8d chore(deps): quiet Node 26 install warnings
0b86961 fix(chat): include Discord channel path in metadata
d2bb86e fix(daemon): decouple restart turn recovery
ec6866f perf(runtime): trim CLI startup and install deps
ea9e5d7 fix(install): handle unresolved bootstrap git refs
07c9922 fix(chat): simplify command permissions
f3cce42 fix(chat): avoid blocking chat ingress on platform acks
d0745a9 fix(scheduler): resume session continuations via worker pool
f7eb689 fix(runtime): reuse Pi token estimates for context usage
c813273 refactor(chat): remove Matrix adapter
5b6800e fix(update): show bare rin update in notices
09cc79a fix(chat): align slash command surfaces
76b3050 docs(self-improve): emphasize whole-context distillation
72eef7d docs(self-improve): clarify implicit distillation guidance
6d87df4 docs(self-improve): remove interactive distillation fallback
bebd37b docs(self-improve): make preference distillation proactive
d796079 docs(self-improve): refine distillation destinations
bd8ffc8 fix(prompt): shorten web source requirement
139ed5c fix(prompt): refine web source requirement wording
6da39b8 fix(prompt): strengthen web source authority
9d061aa fix(chat): simplify Discord command acknowledgement
5f1388e fix(chat): reject legacy inbox chat keys
a2b1748 fix(chat): canonicalize legacy inbox keys
6a6ee87 fix(chat): require bot-qualified chat keys
-->

## 0.6.0

- Installer and bootstrap flows are more reliable across Git/source installs, PowerShell wrappers, Node.js prerequisites, optional native dependency retries, and Electron dependency handling.
- Quick-run setup now supports subscription and OAuth device-code login paths, keeps daemon sockets isolated, launches the TUI after preparation, and exits cleanly on interrupts or closed terminals.
- Chat delivery and notices are calmer and clearer with restored stranded inbox items, fewer artificial inbox caps, markdown todo strikethrough rendering, improved todo notice rendering, quiet handling for missing adapter state, more reliable Telegram Bot API routing, longer-lived working indicators, and retry-exhaustion errors that surface to chat users.
- Prompts now require current web sources when source-dependent information matters, and context pruning keeps loaded skill guidance available.
- Beta, stable, and nightly release metadata commits now use the verified release gate explicitly, so executor metadata updates are not blocked by local hooks after validation already passed.
- Matrix chat support now has a runtime adapter with shared room routing, SDK-based media sending, and throttled isolated typing requests.
- Daemon/session shutdown is safer around lifecycle cancellation, worker exits, session routing, and in-flight turn settlement.
- Chat steering and diagnostics are tighter with accepted-inbox deduplication and a compact usage command.
- Discord and Matrix chat routing is more robust around owner-only channel detection, first-bot defaults, slash-command syncing, recoverable steered inbox items, typing/lifecycle noise, message isolation, and outbox timeout retries.
- Bundled upstream skill provenance is refreshed so installed built-in skill metadata stays traceable.
- Rin now tracks the Pi 0.80.2 dependency line for this release series.

- Diagnostic commands now have dedicated interactive TUI frontends with shared backend logic for cleaner troubleshooting workflows.
- Runtime and installer version reporting now use concrete release metadata instead of changelog fallbacks, with stricter git bootstrap version resolution and BOM-tolerant metadata reads.
- Chat media delivery keeps media attachments as markdown paths and limits quiet delivery suppression to the intended final kinds.
- Compaction preserves todo snapshots, the runtime recognizes current user aliases, and installer defaults better match the detected user, language, install directory, and daemon readiness behavior.
- Browser/search setup is simpler after syncing agent practices docs, removing the bundled browse sidecar, and preparing SearXNG runtime dependencies on Windows.
- Rin now tracks the Pi 0.79.10 dependency line for this release series.
<!-- rin-changelog-coverage
1098735 fix(chat): defer Discord command sync until ready
161e576 feat(chat): add Discord slash commands
e591789 chore(upstream): refresh skill-creator provenance
84a812c fix(chat): avoid unbounded Discord owner-only member fetch
7870b89 fix(chat): define Discord owner-only by human users
231b6e6 fix(chat): allow bot-only Discord owner channels
8dea8fd fix(chat): treat Discord owner-only channels as private-like
b1f2d9e fix(chat): preserve default first-bot chat keys
e718bd1 fix(prompt): require search engine sources
d638d70 fix(frontend): replay pending terminal events after recovery
837a9e6 fix(chat): retry Matrix outbox timeouts safely
e11ff29 fix(chat): keep steered inbox items recoverable
9f45b37 fix(chat): smooth typing and lifecycle errors
f49b8e9 fix(chat): isolate Matrix message sends
234e03c fix(tui): exit when input terminal closes
23ec260 fix(installer): exit quick run tui on interrupt
22df209 fix(installer): keep quick run on default daemon socket
61b2ee0 fix(installer): isolate quick run daemon socket
4c09e42 fix(installer): restore quick run temporary backend
08c7e24 fix(installer): keep provider details in prompt hints
e492201 fix(installer): launch tui after quick run prepare
32bc27a fix(installer): make quick run prepare-only
d89e28f fix(chat): keep missing adapter state quiet
f3f49fd fix(installer): route main wrappers through main entrypoint
ebfeba8 docs(installer): route beta and git through source entrypoints
740c406 fix(chat): use markdown todo strikethrough
21ab805 feat(installer): add quick run mode
4ba02e7 fix(installer): align oauth callbacks and user checks
fc7eaeb fix(chat): remove inbox active worker cap
1d40b45 fix(installer): support oauth device code login
8cbe1f9 fix(chat): remove inbox drain stale and batch caps
90c9dc8 fix(installer): support subscription login selection
f0f51ac fix(build): make git install build cross-platform
045fd4a fix(chat): restore all stranded inbox items on startup
c283647 fix(bootstrap): remove stable Electron dependency rewrite
07ef273 fix(bootstrap): exclude disabled Electron GUI dependency
7302faa fix(chat): remove todo emoji text selector
27915db fix(bootstrap): remove npm install retry cleanup
95c191b feat(chat): improve todo notice rendering
ccbb0dc fix(bootstrap): retry npm install after optional dependency miss
c93f813 fix(bootstrap): tolerate native stderr warnings
d281aa2 fix(bootstrap): preserve node version exit code
a79e30d docs(readme): document Node.js install prerequisite
d21777d fix(bootstrap): avoid splatting empty PowerShell args
2d15136 fix(bootstrap): accept bare PowerShell mode args
3a1a01a fix(bootstrap): handle PowerShell mode binding
c2e27e5 fix(bootstrap): bind PowerShell entrypoint mode
9919536 fix(bootstrap): pass PowerShell wrapper mode as parser args
7c03b8c fix(release): keep beta and stable metadata commits hook-independent
6b15b59 docs(release): cover 0.6.0 nightly changes
8ff476f docs(release): cover 0.6.0 nightly changes
aa1bd7f feat: add interactive diagnostic TUIs
dbeb4b7 feat: split diagnostic command frontends and backends
08362f8 fix: preserve todo snapshot in compaction
28c13ef fix(chat): keep media as markdown paths
e763b2b fix(chat): gate quiet delivery by final kind
0b3a285 fix: resolve git bootstrap versions to commits
00681f5 fix: require concrete git runtime versions
9207d16 fix: make runtime version metadata authoritative
c3428eb fix: tolerate BOM in installed version metadata
f77e32c fix: avoid changelog as runtime version
fe8a450 fix: read installed runtime version
cdd055e fix: recognize current user aliases in rin runtime
876174b fix: use current profile home for installer user
f20c302 fix: use uniform daemon readiness timeout
ed7f302 fix: preselect detected installer language
2b1d03c fix: remove install directory chooser
3da1a57 fix: detect Windows installer language
ed0dc62 feat: sync agent practices docs
159bf22 refactor: remove bundled browse sidecar
ddada51 fix(browse): prepare SearXNG runtime on Windows
8337478 fix(installer): require canonical release handoff casing
519a314 fix(installer): parse PowerShell release handoff
0dcd66d fix(installer): launch Windows cmd shims through shell
dab896e chore(deps): sync Pi 0.79.10
4871772 docs(release): cover 0.6.0 nightly changes
23bf20a docs(release): cover 0.6.0 nightly prep
186dfc1 fix(chat): report transient retry errors
b993261 fix(chat): route Telegram Bot API through grammY
99940f8 fix(chat): keep working indicators until final delivery settles
d4f0f1a feat(prompt): require current web sources
4d89f80 fix(context): preserve skill read results when pruning
5dd0364 chore: sync Pi 0.80.1
c1d6300 chore(deps): sync Pi 0.80.2
7f4f09f fix(session): settle turns before lifecycle shutdown
adf634f fix(daemon): skip stopping workers for session routing
4a5dedb feat(chat): add Matrix runtime adapter
42f0628 fix(chat): use shared routing for Matrix rooms
d8bb1ac fix(chat): send typing for steered chat turns
be830d1 Revert "fix(chat): send typing for steered chat turns"
e662480 fix(daemon): stop flushing sessions on worker exit
0c80991 fix(chat): make frontend lifecycle cancellation silent
80af2d1 fix(chat): migrate Matrix adapter to SDK
276128e fix(chat): send Matrix media through SDK
431722e fix(chat): dedupe accepted steering inbox items
b385a9c feat(chat): add compact usage command
39af518 fix(chat): throttle Matrix typing requests
8d1a85c fix(chat): isolate Matrix typing requests
-->

## 0.5.0

- Chat and daemon recovery is more resilient: active submitted turns stay attached during recovery, accepted inbox turns recover after restarts, passive notices target the right chat session, replaced resume workers shut down cleanly, and outbox delivery stalls are isolated from other chat traffic.
- Chat bridge delivery is more reliable across queued submissions, duplicate recovered finals, recovered final idempotency, typing indicators, per-chat model options, and slow daemon activity status checks.
- CLI and installer flows are clearer and safer: `rin` is now the unified interactive command, print mode can run without the daemon, update-mode source handling is more stable, and native Windows daemon/TUI install is supported.
- Provider and compact-command failures now surface more accurately, including retry-exhaustion details without extra compact acknowledgements.
- The todo tool can now read the current checklist when called without replacement data, matching the documented checklist workflow.
- Scheduler and self-improve operations are easier to maintain with explicit scheduler reloads, quiet-mode scheduled tasks, more complete verified-success capture, 24-hour activity review during nightly distillation, and target-state distillation guidance.
- Installer lifecycle handling is smoother across first-run setup, cross-user Windows targets, and macOS/Windows daemon control.
- Rin now tracks the Pi 0.79.6 dependency line for this release series.
- Release executors now verify changelog coverage against included commits before publishing stable or prerelease metadata.
- Chat delivery and command-error recovery are tighter: media outbox delivery now runs asynchronously, command errors reuse the private-like scope when appropriate, outbox dispatch no longer blocks the chat lane, and OneBot sends have bounded timeouts.
- TUI update notices align with the Rin rendering boundary, and Rin now tracks the Pi 0.79.8 dependency line for this release series.
- Dependency maintenance resolved the current npm audit advisories.
- Empty todo-read results no longer emit noisy chat notices.
- Nightly release metadata commits now use the verified release gate explicitly, so executor metadata updates are not blocked by local hooks after validation already passed.
- Rin now tracks the Pi 0.79.9 dependency line for this release series.

<!-- rin-changelog-coverage
5a2999d fix(chat): keep rich delivery after segment failures
cc2212d fix(chat): finish inbox jobs after delivery ack
737c1df fix(installer): hide cross-user local target on Windows
e51eef4 fix(cli): support macOS and Windows daemon lifecycle
a4fa9a4 feat(installer): simplify first-run setup ownership
2232eba feat(cron): add quiet mode to scheduled tasks
d128a82 fix(chat): mark steered inbox processed on start
2920ef7 chore(deps): sync Pi 0.79.6
278f865 docs(release): cover 0.5.0 nightly changes
5cf9db2 fix(cli): run print mode without daemon
e583326 test(installer): stabilize update-mode source boundary
9adc476 fix(chat): stop gating queued inbox submissions
66a8f31 fix(self-improve): capture verified success paths
0b2811f feat(cli): make rin the unified interactive command
dde1b1f feat(windows): support native install daemon and tui
f606721 fix(chat): avoid duplicate recovered finals
7c8b88b fix(chat): prune completed outbox history
d633762 fix(chat): refresh claimed inbox leases
cdb97cf fix(chat): bound inbox backlog recovery
4ad2f80 fix(chat): archive completed outbox items
84836b4 chore(deps): sync Pi 0.79.5
b818f62 Retry invalid Telegram photos as documents
5da2e26 Handle slow daemon activity status responses
f14f7e9 Fix chat accepted inbox restart recovery
21f8022 Fix chat final delivery recovery idempotency
ab461fd feat(tasks): add explicit scheduler reload
71a7ecc fix(chat): narrow ordinary typing activity
f79372e fix(chat): clear recovered submitted turn activity
b209f9a feat(chat): add per-chat model options
c2efdfa fix(self-improve): review 24h activity in nightly distillation
d83cc5f chore(deps): sync Pi 0.79.4
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
811a469 chore(deps): sync Pi 0.79.7
dc0c2e6 fix(tui): align Rin update notice rendering
c6378b7 fix(chat): make media outbox delivery asynchronous
5b38149 fix(chat): reuse private-like scope for command errors
9c271de docs(release): cover 0.5.0 nightly changes
1750714 docs(release): cover changelog prep commit
a1307d3 chore(deps): sync Pi 0.79.8
42e06fe fix(chat): suppress empty todo notices
9af6acf chore(deps): resolve npm audit advisories
d7871a0 fix(chat): async outbox dispatch and onebot timeouts
e9be369 docs(release): cover 0.5.0 nightly changes
81b7c78 docs(release): cover changelog prep commit
f803ef5 fix(release): keep nightly metadata commits hook-independent
277d21a chore(deps): sync Pi 0.79.9
13aa217 docs(release): cover 0.5.0 stable candidate
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
