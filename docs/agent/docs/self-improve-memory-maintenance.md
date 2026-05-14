# Self-improve memory maintenance manual

## Purpose

Use this manual to improve the existing self-improve memory library: prompt baselines and skills.

Each review starts from the current library, consolidates what already exists, and stores only future-useful conclusions. The maintenance target is `<agentDir>/self_improve`; product docs, bundled docs, and upstream skill sources are outside this review target.

## Memory surfaces

### Prompt baselines

Location: `<agentDir>/self_improve/prompts/*.md`

- `agent_profile.md`: stable agent role, voice, behavior style, and standing expectations; limit 8 lines.
- `user_profile.md`: basic user information; limit 4 lines.
- `core_doctrine.md`: durable methodology, worldview, values, and decision rules; limit 32 lines.

Rewrite a prompt slot as a compact canonical replacement. Keep one dense line per topic.

### Reusable skills

Location: `<agentDir>/self_improve/skills`

Use ordinary skills for reusable workflows, procedures, checklists, references, examples, and troubleshooting playbooks. Shape each skill around a recurring domain or workflow. Put related lessons into the closest matching skill with clear headings.

### Special memory skill layout

Use these fixed destinations under `<agentDir>/self_improve/skills`:

- `short-term-memory/SKILL.md`: the only short-term memory skill. It contains all active short-term event records.
- `memory-index/SKILL.md`: the only discoverable memory-index entry skill. It routes to monthly index directories under `memory-index/YYYY-MM/`. Each monthly directory contains its own `SKILL.md` index file, and each monthly index entry points to one memory transaction file such as `memory-index/YYYY-MM/transactions/YYYY-MM-DD-topic.md`.
- `people-and-relationships/SKILL.md`: semantic memory for named people, preferred titles and forms of address, and relationships. Update it whenever a memory item depends on who a person is, how they should be addressed, or how people relate.
- `object-relationships/SKILL.md`: semantic memory for non-person entities and relationships among them. Update it whenever a memory item depends on what things are or how they relate.

## Review posture

Start from the existing library.

1. Read current prompt slots.
2. Inspect the relevant reusable skills and fixed memory skill destinations.
3. Find repeated, misplaced, stale, verbose, narrow, or overlapping material.
4. Merge, move, rewrite, delete, or prune existing material.
5. Add new material only when it improves future routing, decisions, execution, or recall.

A useful review may only clean existing memory.

## Distillation workflow

1. Extract candidate lessons from the available evidence.
2. Score each candidate quickly:
   - attention: affects future behavior;
   - emotion: strong correction, risk, preference, or blocker;
   - repetition: repeated in evidence or confirmed by existing memory.
3. Choose the smallest correct destination:
   - prompt slot: applies across most future turns;
   - existing reusable skill: fits a recurring workflow or domain;
   - `memory-index`: future lookup, provenance, chronology, or transaction context matters;
   - `short-term-memory`: active temporary continuity;
   - `people-and-relationships`: person identity, address, or relationship context matters;
   - `object-relationships`: non-person entity or relationship context matters;
   - no write: low-signal, one-off, stale, speculative, or already covered.
4. Rewrite the destination compactly.
5. Validate skill frontmatter after editing skills.

## Skill organization

Follow the skill-creator skill when creating or editing skills. Follow the prompt-engineer skill when writing prompts, descriptions, docs, and reusable instructions.

Prefer broad reusable workflows over narrow fragments. Keep, merge, move, delete, or turn skills into intentional aliases according to their current value.

Create a new ordinary skill only when:

- the trigger is reusable;
- the scope covers a workflow, domain, or playbook;
- existing skills do not provide a clean home.

Keep an ordinary skill only when it still has a distinct recurring trigger and enough reusable workflow, reference, or troubleshooting value to justify a separate file.

When several related lessons appear together, make one composite skill with headings. Move or delete narrow fragments instead of preserving them as standalone skills.

## Consolidation checklist

Use this checklist in every review:

- prompt slots that need updates after repeated behavioral feedback;
- overlapping skills that should merge or become a single canonical skill with only intentional aliases left;
- broad skills that need clearer structure;
- narrow skills that belong inside a larger workflow;
- content filed under the wrong skill;
- stale entries inside `short-term-memory/SKILL.md`;
- missing monthly `memory-index` entries or transaction pointers for important lookup evidence;
- missing or stale `people-and-relationships` entries for person/title/relationship context;
- missing or stale `object-relationships` entries for non-person entity or relationship context;
- verbose historical wording that can become compact guidance;
- path, filename, or terminology drift between the manual, prompt slots, and skill files.

## Final output

Report durable memory changes only:

- changed memory files with one short reason each;
- merged, moved, deleted, or pruned memory items;
- cleanup performed when no new memory was added, or that no durable memory file changes were warranted;
- skipped memory items needing owner confirmation or fresher evidence.
