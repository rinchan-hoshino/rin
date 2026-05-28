# Self-improve memory maintenance manual

## Scope

Use this manual to improve the existing self-improve memory library: prompt baselines, reusable skills, fixed memory skills, and short-term records.

The maintenance target is `<agentDir>/self_improve`. Product docs, bundled docs, and upstream skill sources are outside this review target.

A review should reduce entropy in the current library. It may add durable memory, but a useful review may only clean, merge, move, rewrite, delete, or prune existing material.

## Operating rules

Start from the existing library. Complete one cohesive pass across all reachable improvement points.

Treat explicit owner corrections, frustration, repeated reminders, and failed prior behavior as high-salience evidence.

Add or keep durable memory only when it improves future routing, decisions, execution, or recall. Preserve original evidence in transcript memory unless a compact memory-index pointer will materially improve future lookup.

Memory-index extraction should preserve topic cohesion. When new evidence belongs to an existing durable topic, update that topic's existing transaction and monthly index line with dated bullets, date ranges, and keywords. Create a new memory-index transaction only for a genuinely distinct topic or for superseding chronology that must stay separate.

Do not turn a memory review into a runtime feature proposal: do not add new built-in tools, prompt contracts, or user-visible workflow requirements unless the owner explicitly asks for that product change.

## Review workflow

1. Inspect the current prompt slots.
2. Inspect the current workflow skill, any umbrella skill that covers the same class of work, and the fixed memory skill destinations.
3. Inspect `<agentDir>/self_improve/state/skill-usage.json` when present. Use low or absent usage as a cleanup signal, not automatic deletion proof.
4. Extract candidate lessons as reusable rules, not incident details. Keep only candidates that change future behavior, routing, decisions, execution, or recall.
5. Discard one-off, stale, solved, speculative, duplicate, emotional-only, and already-covered candidates.
6. Score each remaining candidate quickly:
   - attention: affects future behavior;
   - emotion: strong correction, frustration, risk, preference, blocker, or failed prior behavior;
   - repetition: repeated in evidence or confirmed by existing memory.
7. Choose the smallest correct destination using the destination priority below.
8. Before creating a memory-index transaction, scan the relevant monthly index for an existing entry with the same domain, object, error, decision, or work thread. Merge into that existing topic transaction when it is the same topic.
9. Rewrite the destination compactly. Replace or remove stale, lower-priority, conflicting, or duplicate lines instead of appending another rule.
10. Prune stale short-term records and move misplaced material to the smallest correct destination.
11. Validate skill frontmatter after editing skills.

## Review priorities

Apply these destination priorities before creating or expanding memory:

1. Owner correction: If the owner corrects behavior, update the relevant skill; replace prompt text only when the rule truly belongs in a prompt baseline.
2. Current skill: if the current conversation used a skill and revealed a gap, patch that current skill first.
3. Umbrella skill: if no current skill applies but an umbrella skill covers the class of work, patch the umbrella skill.
4. Skill `references/`: if detailed reusable evidence, examples, command traces, or longer notes are needed, put them under the owning skill's `references/` directory and keep `SKILL.md` concise.
5. New reusable skill: create a new ordinary skill only when no current or umbrella skill is a clean home and the lesson is a reusable class-level workflow, domain, or playbook.
6. Time-based memory: put active temporary continuity in `short-term-memory`; put historical evidence, chronology, provenance, or transaction context in `memory-index`. For `memory-index`, prefer one evolving topic transaction over multiple per-conversation entries for the same topic.
7. No write: if no durable memory change is useful, report a no-op with one concise reason.

Use this destination map when selecting a target:

- prompt slot: applies across most future turns;
- current skill: the active workflow skill was used and has a gap;
- umbrella skill: a broader existing skill cleanly covers the lesson;
- skill `references/`: detailed reusable evidence or examples are useful but too bulky for `SKILL.md`;
- new reusable skill: no current or umbrella skill is a clean home, and the lesson is class-level reusable;
- `memory-index`: future lookup, provenance, chronology, or transaction context matters;
- `short-term-memory`: active temporary continuity;
- `people-and-relationships`: person identity, address, or relationship context matters;
- `object-relationships`: non-person entity or relationship context matters;
- no write: low-signal, one-off, stale, speculative, or already covered; include one concise no-op reason in the final output.

## Memory surfaces

### Prompt baselines

Location: `<agentDir>/self_improve/prompts/*.md`

- `agent_profile.md`: stable agent role, voice, behavior style, and standing expectations; limit 8 lines.
- `user_profile.md`: basic user information; limit 4 lines.
- `core_doctrine.md`: durable methodology, worldview, values, and decision rules; limit 32 lines.

Use prompt baselines only for every-turn identity, user identity, or doctrine invariants. Put procedures, examples, durable facts, and troubleshooting detail in skills or memory-index destinations.

Rewrite a prompt slot as a compact canonical replacement. Keep one dense line per topic. When a new rule supersedes existing prompt text, replace or remove the lower-priority/conflicting line instead of appending another rule. Prefer shrinking an overgrown baseline over preserving every historical instruction.

### Reusable skills

Location: `<agentDir>/self_improve/skills`

Use ordinary skills for reusable workflows, procedures, checklists, references, examples, and troubleshooting playbooks. Shape each skill around a recurring domain or workflow.

Put related lessons into the closest matching skill with clear headings. Prefer updating the closest existing skill; when a lesson comes from a workflow where a skill was already in play, patch that skill before creating a new one.

Use `references/` under the owning skill for detailed reusable evidence, examples, command traces, or longer notes that would make `SKILL.md` too noisy. Keep `SKILL.md` as the operational entry point and link or summarize the reference only when future execution needs it.

### Fixed memory skills

Use these fixed destinations under `<agentDir>/self_improve/skills`:

- `short-term-memory/SKILL.md`: the only short-term memory skill. It contains all active short-term event records.
- `memory-index/SKILL.md`: the only discoverable memory-index entry skill. It routes to monthly index directories under `memory-index/YYYY-MM/`. Each monthly directory contains its own `SKILL.md` index file, and each monthly index entry points to one memory transaction file such as `memory-index/YYYY-MM/transactions/YYYY-MM-DD-topic.md`. Transaction files are durable topic buckets with dated evidence; merge repeated same-topic evidence into the existing transaction and update the monthly index date range/keywords.
- `people-and-relationships/SKILL.md`: semantic memory for named people, preferred titles and forms of address, and relationships. Update it whenever a memory item depends on who a person is, how they should be addressed, or how people relate.
- `object-relationships/SKILL.md`: semantic memory for non-person entities and relationships among them. Update it whenever a memory item depends on what things are or how they relate.

## Skill lifecycle

Follow the skill-creator skill when creating or editing skills. Follow the prompt-engineer skill when writing prompts, descriptions, docs, and reusable instructions.

Prefer broad reusable workflows over narrow fragments. Keep, merge, move, delete, or turn skills into intentional aliases according to their current value.

Create a new ordinary skill only when:

- the trigger is reusable;
- the scope covers a reusable class-level workflow, domain, or playbook;
- existing skills do not provide a clean home;
- the lesson is not just a one-off issue, PR, error string, session artifact, or temporary implementation detail.

Keep an ordinary skill only when it still has a distinct recurring trigger and enough reusable workflow, reference, or troubleshooting value to justify a separate file. Alias, paused, internal, or fixed lookup skills must be intentional and compact; otherwise merge or delete them instead of keeping them visible by inertia.

When several related lessons appear together, make one composite skill with headings. Move or delete narrow fragments instead of preserving them as standalone skills.

## Consolidation checklist

Use this checklist in every review:

- prompt slots that need updates after repeated behavioral feedback;
- overlapping skills that should merge or become a single canonical skill with only intentional aliases left;
- skill usage statistics that suggest stale, unused, or rarely used ordinary skills worth merging, aliasing, or pruning;
- broad skills that need clearer structure;
- narrow skills that belong inside a larger workflow;
- content filed under the wrong skill;
- stale entries inside `short-term-memory/SKILL.md`;
- missing monthly `memory-index` entries or transaction pointers for important lookup evidence;
- near-duplicate same-topic `memory-index` transaction files that should be merged into one topic transaction with dated bullets;
- missing or stale `people-and-relationships` entries for person/title/relationship context;
- missing or stale `object-relationships` entries for non-person entity or relationship context;
- verbose historical wording that can become compact guidance;
- path, filename, or terminology drift between the manual, prompt slots, and skill files.

## Final output

Report durable memory changes only:

- changed memory files with one short reason each;
- merged, moved, deleted, or pruned memory items;
- cleanup performed when no new memory was added, or that no durable memory file changes were warranted with one concise no-op reason;
- skipped memory items needing owner confirmation or fresher evidence.

Do not leave an empty final response.
