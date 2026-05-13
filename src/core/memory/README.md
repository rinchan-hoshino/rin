# memory

Rin's builtin session-history memory module.

Public tool:

- `search_memory` — query past sessions, or leave `query` empty to browse recent sessions directly

Extension API:

- daemon worker extensions can call `ctx.registerMemoryProvider(provider, options)`
- providers may implement `search`, `listRecent`, and `write`
- `write` receives the same transcript archive entries produced by Rin's existing memory archival flow
- provider results may use remote references such as `reference` or `url` instead of local transcript paths, so external systems do not need to expose local original-text storage

## Responsibilities

This module owns:

- transcript archiving under `~/.rin/memory/transcripts`
- best-effort archive write and search fan-out to registered daemon memory providers
- a persistent derived search index under `~/.rin/memory/search.db`, lazily synced from transcript archives
- archived session records preserve full message history for recall, including assistant thinking text, tool calls, tool results, and other text-bearing message roles
- recent-session previews favor actionable entries such as assistant steps, tool activity, commands, paths, and unresolved blockers instead of generic chatter
- cross-session transcript search with session-level rollup: search gathers many raw message hits, merges them by session, and returns session-scoped recall results
- transcript recall summarization via the active model at fixed `low` thinking
- recall summaries are steered to fuse the overall session context with why the current query matched

It does not own always-on prompts or agent-managed skills. Those belong to the `self-improve` module.

In the layered memory model, this module owns episodic memory: original session material that can be reactivated through targeted recall instead of being copied into the always-on prompt.
