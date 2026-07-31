# Rin Technical Architecture

This page is for developers changing Rin's source. It explains the maintained boundaries to use before adding new modules, tests, or runtime entrypoints.

## Product shape

Rin is a local, daemon-style assistant built on Pi. The runtime centers on:

- sessions and resumable worker state,
- markdown-backed long-term memory,
- scheduled background tasks,
- chat and terminal frontends that talk to the same daemon-owned runtime,
- a small set of first-party capabilities wired directly through Rin core.

Keep changes aligned with that shape. Prefer one clear runtime path over compatibility wrappers, mirrored state, or separate frontend-specific behavior.

## Source layout

- `src/app/`: executable entrypoints and product assembly.
  - `rin`: CLI entrypoint and command routing.
  - `rin-daemon`: daemon process and worker process entrypoints.
  - `rin-tui`: terminal frontend implementation used by the `rin` command.
  - `rin-gui` and `rin-desktop-host`: dormant GUI implementation material while the desktop UI is redesigned; not installed as public commands.
  - `rin-install`: installer entrypoint.
- `src/core/`: reusable implementation modules used by the app entrypoints.
  - `rin-lib`: shared runtime prompt, changelog, model, update, and system helpers.
  - `rin-daemon`: daemon runtime, worker pool, RPC state, and process orchestration.
  - `session`: shared session path and managed-session helpers.
  - `memory`, `task`, `chat`, `chat-bridge`, `token-usage`, and `self-improve`: first-party capability domains.
  - `platform`: shared filesystem, process, and OS utilities.
  - `pi`: Pi integration shims and helpers.
- `tests/`: TypeScript tests split into `unit`, `e2e`, and `interactive` buckets.
- `upstream/`: tracked upstream Pi and builtin skill mirrors; refresh with the sync scripts instead of editing mirrored content casually.

## Runtime layering

Rin should keep these layers distinct:

1. **Product entrypoints** parse commands, select frontend mode, and assemble the runtime.
2. **Pi workers and the daemon** own turn execution: the worker produces complete/error truth, while the daemon supervises workers, persists the authoritative lifecycle ledger, and routes events.
3. **Capability domains** register concrete tools and prompt support through their owning modules.
4. **Adapters and frontends** translate terminal, chat, scheduled, and future GUI input into the same runtime semantics.

Do not add a frontend-only session model, local mirror of daemon state, or hidden compatibility runner when the daemon/core boundary can express the behavior directly.

## Turn lifecycle and terminal delivery

There is one lifecycle owner and one durable handoff:

- The daemon admits each request into `data/core/daemon/turn-ledger.sqlite` before writing the command to a worker. SQLite's native WAL mode provides transaction durability; Rin does not maintain an application-level terminal WAL.
- A Pi worker is the only producer of `complete` or `error` truth. A daemon or worker restart does not terminalize an admitted request: the daemon preserves the active ledger row, opens the same Pi session in one replacement worker, and resumes the same `requestTag`.
- Worker recovery never resubmits the user prompt. It continues a persisted user or tool-result leaf with Pi's native continuation runner. If a tool call was interrupted, the worker first appends Pi's canonical error tool result (`reason: daemon_exit`); if Pi had already persisted a completed assistant message, the replacement worker re-emits that result as the original turn's producer.
- A terminal record is immutable and identified by one `requestTag` and one `terminalId`. Exact await and reconnect replay are level-triggered views of that same record, never independent lifecycle decisions. The waiter belongs to `requestTag`, not to a worker, and remains pending while replacement is temporarily unavailable. Relative or absolute spellings of the same session path are routing details and cannot strand it.
- Chat owns `inbox_jobs`, messages, and platform outbox delivery only. On restart it places inherited running chat keys in the existing inbound-recovery gate before adapters start, attaches those jobs to the daemon request without submitting the prompt again, and releases each key only after its recovered worker becomes idle. Later messages remain buffered behind that turn. Chat does not revive, supersede, infer, or mirror Pi lifecycle state.
- Chat atomically settles the matching inbox job and inserts a deterministic terminal outbox row before acknowledging the daemon record. Frontends require the daemon `requestTag` to route and dedupe terminal replay; `terminalId` remains the immutable ledger/outbox record identity, and process-local worker generation is never lifecycle identity. A terminal is marked projected only after listeners commit; listener failure retries the same record. A crash before acknowledgement causes replay; the outbox identity makes replay idempotent. Settlement ends the in-memory controller turn and resumes the per-chat drain. External platform delivery remains at-least-once.
- Daemon shutdown stops frontend admission and gives active workers a bounded graceful drain. Work that outlives the process remains active in the ledger and follows the same startup recovery path instead of becoming `worker exit`.
- Working is a backend semantic state, not a frontend lifecycle inference. The daemon derives one level-triggered `working` value from owned worker activity and includes it in state snapshots and forwarded events. TUI, Chat, and future frontends only translate that value into platform presentation. A TUI extension's `setWorkingVisible` request is a local presentation preference and never changes backend Working truth.
- On install, schema v9 rebuilds the Chat delivery tables and retires old `chat_runs`, `run_id`, and application terminal-WAL artifacts after the installer backup. Unverifiable in-flight work from pre-ledger schemas becomes `failed/interrupted`; current ledger-owned turns use the recovery contract above.

Do not add fallback terminal replay files, Chat-owned canonical runs, submitted-turn inference, user-prompt replay, or a second terminal identifier. Crash recovery must consume the authoritative ledger and Pi session state through the single daemon/worker path.

## Session lifecycle identity

Keep logical session selection separate from persistence:

- `sessionId` and the daemon connection attachment identify the selected runtime session immediately;
- `sessionFile` is only the persistence locator and may be absent until the session records real conversation content;
- `/new` replaces the logical session reference even when the new worker has no file yet, and chat reset generation clears the old persisted binding;
- the first later prompt with no persisted binding creates a fresh managed session with current prompt resources, then stores the resulting file;
- the previous worker shutdown lifecycle must not depend on the replacement session already having a file.

Do not use a non-empty `sessionFile` as proof that `/new` selected the new logical session, or preserve an old file when a new-session response intentionally has none.

## Documentation layout

- User docs: `README.md` plus translated `readme/README.*.md` files.
- Agent docs source: `docs/agent/`, installed to `agentDir/docs/rin/`.
- Developer docs: `docs/developer/`.
- Release-note metadata: `docs/release/CHANGELOG.md`.

Delete obsolete plans, todo files, and AGENTS-style local instruction documents instead of letting them become unofficial requirements.

## Dependency and generated-output rules

- Use Node.js 22.19.0 or newer; this is Rin's minimum runtime and release-build baseline.
- Run `npm ci` in fresh clones before build, lint, or tests.
- TypeScript source uses NodeNext/ESM runtime suffixes, so relative imports in `.ts` files normally keep `.js` suffixes.
- Keep scratch files out of the repository.
- Generated `dist/` output is not source; clean unrelated generated churn before committing.
- Use TypeScript for new repository automation unless a real runtime boundary requires a JavaScript script.
