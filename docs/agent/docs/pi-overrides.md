# Pi Overrides in Rin

Use this document when upstream Pi docs are relevant to a Rin task.

Rin docs are the installed Rin layer. Pi docs are the upstream base layer. A Rin task uses Pi docs through the Rin layer.

## Override contract

For Rin behavior, choose authority in this order:

1. current system prompt and live tool list for this turn;
2. installed Rin docs for Rin runtime behavior;
3. narrow Rin topic docs for the surface being changed;
4. upstream Pi docs for base behavior outside Rin coverage;
5. live state from the target runtime, repository, daemon, or service.

When Rin docs and Pi docs describe the same Rin surface differently, apply the Rin document and cite the Rin surface used.

## Resolution flow

1. Identify the target surface: runtime path, memory/retrieval, self-improve, capability/tooling, chat bridge, scheduled task, extension, or upstream Pi base behavior.
2. Read the narrow Rin topic document for that surface.
3. Use Pi docs for the base implementation model when the Rin topic document delegates or leaves the behavior open.
4. Verify with live state when the task depends on installed files, daemon state, tool availability, or service configuration.
5. Report the effective authority: Rin doc, Pi doc, or live state.

## Rin interpretation map

### Runtime paths

Use Rin stable paths under `~/.rin/...`. Runtime layout, launcher ownership, install manifests, app releases, and maintenance target verification are defined in `docs/runtime-layout.md`; update and rollback policy belongs to `docs/capabilities.md`.

### Memory and self-improve

Use Rin terminology:

- memory preserves original evidence and retrieval;
- self-improve stores distilled reusable guidance.

Read `docs/memory-layering.md`, `docs/self-improve-distillation.md`, and `docs/capabilities.md` before changing either surface.

### Capabilities

Use the live tool list for the current turn and Rin capability docs for installed behavior. Rin agent-facing surfaces include archived memory search, core todo, scheduled tasks, chat bridge configuration, and bundled web search with URL fetching.

Read `docs/builtin-extensions.md` and `docs/capabilities.md` for the current Rin layer.

### Documentation paths

Use installed stable documentation paths:

- `~/.rin/docs/rin/...`: Rin-specific agent docs.
- `~/.rin/docs/pi/...`: upstream Pi reference docs installed with Rin.

## Report contract

When a task used Pi docs, report:

- the Rin surface affected;
- the Rin doc that governed the decision;
- the Pi doc or concept used as base reference;
- the live-state verification when it affected the result.

## Read next

- Turn-level environment and live target checks: `docs/execution-environment.md`.
- Installed runtime paths and manifests: `docs/runtime-layout.md`.
- Capability surfaces: `docs/capabilities.md` and `docs/builtin-extensions.md`.
- Memory/self-improve destination choice: `docs/memory-layering.md`.
