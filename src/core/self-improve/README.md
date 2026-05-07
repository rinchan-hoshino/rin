# self-improve

Rin's builtin self-improvement module.

Public tool: none. Prompt baseline writes are handled by internal self-improve maintenance flows.

## Responsibilities

This module owns:

- always-on prompt baselines under `~/.rin/self_improve/prompts`
- agent-managed reusable skills under `~/.rin/self_improve/skills`
- memory-index skills under `~/.rin/self_improve/memory_index_skills`
- short-term event-memory skills under `~/.rin/self_improve/event_memory_skills`
- onboarding for resident self-improve prompts
- periodic, pre-compaction, and session-shutdown self-improve review, with periodic review defaulting to every 5 user turns and configurable via `settings.json -> selfImprove.reviewEveryTurns`

It does not own session-history recall. That belongs to the `memory` module.

In the layered memory model, self-improve owns compact control memory and procedural/cortical memory: prompt baselines for stable every-turn identity and doctrine, ordinary skills for reusable workflows, knowledge, concepts, and durable facts, memory-index skills for compact event lookup, and short-term event-memory skills that maintenance can merge or discard.

## Prompt slots

- `agent_profile`
- `user_profile`
- `core_doctrine`

`agent_profile` stores Rin's stable role, tone, behavior style, and standing expectations for how Rin should generally respond. `user_profile` stores the user's identity knowledge. `core_doctrine` stores durable methodology, worldview, and values. Durable facts, reference material, operating knowledge, and concepts are consolidated through skills and transcript memory.

Prompt slots are identified directly by filename under `~/.rin/self_improve/prompts/`.
For example, `~/.rin/self_improve/prompts/agent_profile.md` is the `agent_profile` slot.
These prompt files are stored as markdown list items.
Internal maintenance should treat the current file content as canonical and rewrite each slot as a full revised replacement rather than as an append-only patch.

Current limit design keeps resident memory deliberately tight: `agent_profile` 8 lines, `user_profile` 4 lines, and `core_doctrine` 32 lines.
