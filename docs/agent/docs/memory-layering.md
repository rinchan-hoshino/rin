# Memory Layering

Rin keeps three memory layers so the system prompt stays compact while detailed experience remains recoverable.

## Mental model

Use a human-memory analogy as a design aid, not as a claim that Rin stores memory like a brain:

- **Always-on prompt baselines are stable control memory.** They contain only stable identity, standing user identity, and durable methods or values that must influence every turn.
- **Skills are cortical/procedural memory.** They store reusable workflows, checklists, examples, branching playbooks, domain knowledge, concepts, and durable facts that should be loaded when the current task matches their descriptions rather than repeated in the system prompt.
- **Transcript archives are episodic memory.** They preserve original session material for later recall through `search_memory`; they should not be summarized into always-on text unless they change future behavior.

This is an engineering analogy only: core constraints stay always active, procedural detail is indexed by skill descriptions, and raw session data remains available by lookup instead of bloating the system prompt.

## Layer responsibilities

### Always-on prompt baselines

Use prompt baselines only for compact rules that must be present every turn:

- `agent_profile`: stable role, tone, behavior style, and standing response expectations.
- `user_profile`: stable user identity knowledge.
- `core_doctrine`: durable methodology, values, and decision rules.

The active prompt baseline set is `agent_profile`, `user_profile`, and `core_doctrine`. Durable facts, reference material, operating knowledge, and concepts are consolidated through skills; raw event evidence belongs in transcript memory.

Keep each line dense and reusable. If a point needs steps, examples, exceptions, or a checklist, move it into a skill and leave only a short pointer or principle in the prompt baseline.

Example: keep "Prefer restore-oriented official data exports over API-only archives" in `core_doctrine` if it must affect every backup decision; put the TickTick/Notion export facts, validation steps, storage layout, and restore checklist in a skill.

### Skills

Use skills for reusable behavior that should be triggered by context:

- operational workflows,
- debugging and validation checklists,
- domain-specific playbooks,
- examples that teach how to act,
- procedures that would bloat the always-on prompt if inlined.

Skill descriptions are the retrieval handles. Write them so the agent can recognize the situations, keywords, and boundaries that make the skill relevant. Keep detailed instructions in the skill body, not in the prompt baseline.

### Transcript archives

Use `search_memory` when the task depends on past conversations, unfinished work, original wording, or evidence that should not be permanently injected into every turn.

Transcript archives are the source for episodic recall. They can inform consolidation, but most raw events should remain archived rather than promoted. When wording, evidence, chronology, or user intent matters, search the transcript instead of relying on a reconstructed summary.

## Consolidation triggers

Rin runs memory review during fixed-round periodic maintenance and on real session shutdown. Idle daemon worker sleep is not session shutdown and does not trigger shutdown memory maintenance. The periodic threshold is counted from real agent final messages, is configurable with `settings.json -> selfImprove.reviewEveryTurns`, and defaults to `5`; user steering inputs and assistant tool-call-only/interim messages do not count.

Daily sleep-style consolidation should use the same rules as a scheduled maintenance pass: revisit short-term memory, merge repeated observations, refresh indexes, and demote or delete stale material rather than adding more resident prompt text.

## Consolidation rules

When reviewing a conversation or adding durable memory, classify the material before writing:

1. **Every-turn identity or doctrine invariant?** Put the shortest useful version in the smallest fitting prompt baseline slot.
2. **Reusable workflow, multi-step policy, durable fact, reference material, or concept?** Create or update a skill.
3. **Original event, evidence, chronology, or historical context?** Leave it in transcript memory; create or update a directory-managed memory-index skill only when a compact time/keyword index would help retrieve it later.
4. **Temporary task state?** Keep it in the active session, current work files, or a short-lived directory-managed short-term event-memory skill; remove it after it stops guiding current work.

Promotion should be selective. These decisions are deliberate consolidation work, not automatic background promotion:

- Score attention/emotion salience from the current work, with explicit owner corrections and strong negative feedback treated as high-salience signals.
- Score repetition across observations as a stability signal.
- Link each candidate to existing prompt lines, skills, or transcript indexes before deciding whether to add, merge, correct, supersede, or discard it.
- Encode by memory type: procedure/reflex -> workflow skill; knowledge/concept/fact -> knowledge skill; event pointer -> directory-managed memory-index skill; temporary active goal -> directory-managed short-term event-memory skill or work file.
- Prefer present-tense target behavior over historical explanations.
- Remove stale or superseded prompt lines when a better skill or fact replaces them.

## Skill index and progressive disclosure

Skills must not become one file per fact. Keep the visible skill index small by using composite skills and progressive disclosure:

1. Broad skill descriptions act as the first-level retrieval index.
2. Skill frontmatter aliases/tags and clear headings act as second-level keyword handles.
3. Detailed facts, examples, emotional-reflex rules, and transcript pointers stay inside the matched skill body.
4. Memory-index skills group event pointers by time and keyword instead of creating a separate skill for every episode.
5. Short-term event-memory skills are directory-managed, short-lived, and should be merged, promoted, or deleted during sleep-style consolidation; they should not become permanent skill-index entries by default.

This keeps system prompt skill metadata compact while still allowing deeper recall after a relevant skill is selected.

## Non-goals

This model does not mean:

- every past conversation should be summarized into durable prompts;
- every repeated topic deserves a new skill;
- transcript archives replace concise prompt baselines for facts needed every turn;
- skills should duplicate stable identity or preference facts;
- every durable fact should become its own skill.

## Retrieval flow

At task time, use the least resident sufficient layer:

1. Follow the always-on prompt baselines for stable posture and constraints.
2. Use available skill descriptions to load relevant procedural detail.
3. Search transcript memory only when original context, evidence, or cross-session continuity matters.

This keeps the resident prompt small while preserving deeper memory through targeted reactivation.
