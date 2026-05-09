# Self-improve memory maintenance manual

## Purpose

Use this manual to improve the existing self-improve memory library: prompt baselines, reusable skills, memory-index skills, and short-term memory skills.

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

### Memory-index skills

Location: an index directory under `<agentDir>/self_improve/skills`

Use memory-index skills for lookup and provenance when the source evidence matters later. Record compact entries with date, keywords, topic, why it matters, and the original memory/source path. Keep entries short and searchable; do not duplicate procedural guidance already stored in an ordinary skill.

### Short-term memory skills

Location: a short-term memory directory under `<agentDir>/self_improve/skills`

Use short-term memory skills for active temporary continuity, fresh state, and short-lived impressions. Review them during maintenance and prune stale entries instead of promoting stale task state into prompts or reusable skills.

## Review posture

Start from the existing library.

1. Read current prompt slots.
2. Inventory all skill directories by name, description, and role before selecting edits.
3. Inspect the reachable files needed to judge duplicate, misplaced, stale, verbose, narrow, or overlapping material.
4. Apply each discovered class of cleanup across the library, not only to the first obvious file.
5. Merge, move, rewrite, delete, or prune existing material.
6. Add new material only when it improves future routing, decisions, execution, or recall.

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
   - memory-index skill: future lookup or provenance matters;
   - short-term memory skill: active temporary continuity;
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

Use this checklist in every review. When one item is found, scan for the same pattern across the library before finishing:

- prompt slots that need updates after repeated behavioral feedback;
- overlapping skills that should merge or become a single canonical skill with only intentional aliases left;
- broad skills that need clearer structure;
- narrow skills that belong inside a larger workflow;
- content filed under the wrong skill;
- stale short-term memories;
- missing memory-index entries for important lookup evidence;
- verbose historical wording that can become compact guidance;
- path, filename, or terminology drift between the manual, prompt slots, and skill files.

## Final output

Report durable memory changes only:

- changed memory files with one short reason each;
- merged, moved, deleted, or pruned memory items;
- cleanup performed when no new memory was added, or that no durable memory file changes were warranted;
- skipped memory items needing owner confirmation or fresher evidence.
