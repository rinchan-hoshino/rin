# Pi Overrides in Rin

This document explains how to interpret upstream pi documentation when operating inside Rin.

## Rule of precedence

When Rin docs and upstream Pi docs overlap on Rin-specific behavior:

- prefer Rin docs first
- use upstream Pi docs as the base reference only when Rin docs do not override the topic
- if there is any conflict about Rin behavior, Rin docs take precedence

## What changes in Rin

### Runtime paths

Do not assume upstream pi runtime paths like `~/.pi/...` apply directly.
In Rin, prefer the stable paths under `~/.rin/...`.
See `docs/runtime-layout.md` for the authoritative layout.

### Memory

Rin separates always-on prompt baselines, skills, and transcript archives.
Do not assume upstream pi memory behavior or prompt injection rules apply unchanged.
See `docs/memory-layering.md` and `docs/capabilities.md` for agent-facing behavior.

### Builtin capabilities

Rin registers additional builtin capabilities such as web search with URL fetching, memory, scheduled-task pause/resume control, and chat bridge configuration directly in core.
Do not reason from upstream pi defaults alone.
See `docs/builtin-extensions.md` and `docs/capabilities.md`.

### Documentation paths

Rin installs stable documentation under:

- `~/.rin/docs/rin/...`
- `~/.rin/docs/pi/...`

Prefer these stable installed paths over release-specific paths.

### Rin-specific behavior

When the task involves Rin runtime behavior, launcher layout, daemon behavior, memory, scheduled tasks, chat bridge behavior, or other Rin-owned features, read Rin docs first and treat them as authoritative.

## Recommended reading order

1. `README.md`
2. `docs/pi-overrides.md`
3. the relevant topic document such as `docs/runtime-layout.md`, `docs/builtin-extensions.md`, `docs/memory-layering.md`, or `docs/capabilities.md`
4. upstream pi docs only as needed, with Rin overrides in mind
