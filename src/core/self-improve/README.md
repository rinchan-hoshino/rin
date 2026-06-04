# self-improve

Rin's builtin self-improvement module.

Public tool: none. Self-improve writes are handled by internal distillation flows.

## Responsibilities

This module owns distilled guidance that changes future agent behavior:

- always-on prompt baselines under `~/.rin/self_improve/prompts`
- agent-managed reusable skills under `~/.rin/self_improve/skills`
- onboarding for resident self-improve prompts
- periodic and session-shutdown self-improve review; periodic review defaults to every 5 real agent final messages and is configurable via `settings.json -> selfImprove.reviewEveryTurns`; user steering inputs and assistant tool-call-only/interim messages do not count

It does not own original session-history recall. Original evidence and retrieval belong to the `memory` module.

`self_improve` may contain memory-index pointers for discoverability, but those pointers support retrieval of original evidence; they do not replace transcript archives.

## Prompt slots

- `agent_profile`
- `user_profile`
- `core_doctrine`

`agent_profile` stores Rin's stable role, voice, behavior style, and standing response expectations. `user_profile` stores stable user identity knowledge. `core_doctrine` stores durable methodology and decision rules.

Durable procedures, reusable examples, workflows, and distilled domain facts belong in skills. Original wording, evidence, chronology, and provenance stay in memory/retrieval surfaces.

Prompt slots are identified directly by filename under `~/.rin/self_improve/prompts/`. For example, `~/.rin/self_improve/prompts/agent_profile.md` is the `agent_profile` slot. These prompt files are stored as markdown list items.

Internal distillation should treat the current file content as canonical and rewrite each slot as a full revised replacement rather than as an append-only patch.

Current limit design keeps resident self-improve guidance deliberately tight: `agent_profile` 8 lines, `user_profile` 4 lines, and `core_doctrine` 32 lines.
