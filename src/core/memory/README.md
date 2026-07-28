# memory

Rin's builtin session-history memory module.

Public tool:

- `recall` — query past sessions, or leave `query` empty to browse recent sessions directly; queried recall defaults to `order: "relevance"` and supports `order: "newest"` for topic-filtered newest-first history

Extension API:

- Rin background extensions can call `ctx.registerMemoryProvider(provider, options)`
- providers may implement `search`, `listRecent`, and `write`
- `write` receives a stable logical record without native storage paths or raw internal content
- providers choose `append` or capability-scoped `replace`
- provider results may use remote references such as `reference` or `url`

## Responsibilities

This module owns:

- native transcript archiving under `~/.rin/memory/transcripts`
- an internal coordinator that composes native memory with extension adapters without registering native memory as an extension
- best-effort writes, global result ordering, and append/replace capability selection
- a persistent derived search index under `~/.rin/memory/search.db`, lazily synced from transcript archives
- archived session records preserve full message history for recall, including assistant thinking text, tool calls, tool results, and other text-bearing message roles
- recent-session previews favor actionable entries such as assistant steps, tool activity, commands, paths, and unresolved blockers instead of generic chatter
- cross-session transcript search with session-level rollup: search gathers many raw message hits, merges them by session, and returns session-scoped recall results
- transcript recall summarization via the active model at fixed `low` thinking
- recall summaries are steered to fuse the overall session context with why the current query matched
- agent-visible recall output includes exact result and matched-message timestamps so the model can compare chronology

It does not own distilled guidance, always-on prompts, or agent-managed skills. Those belong to the `self-improve` module.

In Rin terminology, memory means original session material plus retrieval: archived transcripts, exact wording, evidence, chronology, provenance, search index, and recall summaries. Distilled reusable guidance belongs to self-improve.
