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
  - `rin-tui`: terminal frontend entrypoint.
  - `rin-gui` and `rin-desktop-host`: GUI launcher and desktop host boundary.
  - `rin-install`: installer entrypoint.
- `src/core/`: reusable implementation modules used by the app entrypoints.
  - `rin-lib`: shared runtime prompt, changelog, model, update, and system helpers.
  - `rin-daemon`: daemon runtime, worker pool, RPC state, and process orchestration.
  - `session`: shared session path and managed-session helpers.
  - `memory`, `task`, `rin-browse`, `chat`, `chat-bridge`, `token-usage`, and `self-improve`: first-party capability domains.
  - `platform`: shared filesystem, process, and OS utilities.
  - `pi`: Pi integration shims and helpers.
- `tests/`: TypeScript tests split into `unit`, `e2e`, and `interactive` buckets.
- `upstream/`: tracked upstream Pi and builtin skill mirrors; refresh with the sync scripts instead of editing mirrored content casually.

## Runtime layering

Rin should keep these layers distinct:

1. **Product entrypoints** parse commands, select frontend mode, and assemble the runtime.
2. **Daemon and worker runtime** owns session attachment, resumable turn state, worker lifecycle, and background execution.
3. **Capability domains** register concrete tools and prompt support through their owning modules.
4. **Adapters and frontends** translate terminal, GUI, chat, or scheduled input into the same runtime semantics.

Do not add a frontend-only session model, local mirror of daemon state, or hidden compatibility runner when the daemon/core boundary can express the behavior directly.

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
