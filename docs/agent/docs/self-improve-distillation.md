# Self-improve Distillation

Use this document when a self-improve review must turn conversation evidence into durable future behavior.

A distillation pass writes behavior contracts for future runs: prompt baselines, skills, memory-index pointers, and short-term continuity.

Memory and self-improve stay separate:

- Memory preserves original evidence and supports retrieval.
- Self-improve stores distilled guidance that changes future agent behavior.

Use `docs/memory-layering.md` for destination choice. Use this document for the actual distillation pass over `<agentDir>/self_improve`.

## Prompt brief

Target surface:

- internal self-improve review and scheduled sleep-consolidation prompts;
- self-improve library under `<agentDir>/self_improve`;
- future prompt/context composition through prompt baselines and skills.

Goal:

- lower guidance entropy while preserving or improving future behavior.

Trusted inputs:

- existing self-improve artifacts;
- current conversation evidence;
- owner corrections and repeated feedback;
- current repository/runtime docs for the surface being edited.

Output contract:

- changed self-improve artifacts with one short reason each;
- merged, moved, deleted, or pruned artifacts;
- cleanup work performed;
- one concise unchanged reason when the library already satisfies the contract;
- candidates routed to product work, memory retrieval, or owner clarification.

## Success criteria

A successful distillation pass makes future behavior easier to trigger and execute:

- the new or revised guidance changes future behavior, routing, decisions, execution, or recall;
- each lesson has one canonical owner;
- prompt baselines stay compact and resident-worthy;
- skills stay workflow-shaped and discoverable by description;
- memory-index pointers support retrieval of original evidence;
- short-term continuity contains active handoff state;
- stale, duplicated, conflicting, or misplaced guidance is merged, moved, or removed;
- final output names the artifacts changed and the behavior contract each change improves.

## Distillation inputs

Inspect the surfaces that can own the lesson:

- prompt baselines under `<agentDir>/self_improve/prompts/*.md`;
- the matching skill used in the conversation;
- umbrella skills covering the same work class;
- fixed semantic skills such as `people-and-relationships` and `object-relationships`;
- memory-index monthly indexes and same-topic transaction files;
- `short-term-memory/SKILL.md`;
- `<agentDir>/self_improve/state/skill-usage.json` when present.

Use owner corrections, frustration, repeated reminders, and repeated assistant failures as high-salience evidence. Extract the reusable behavior lesson and file it in the smallest self-improve surface that will affect later behavior.

## Behavior contract

Run one cohesive same-class pass:

1. Read the current prompt baselines.
2. Read the matching skill and any umbrella skill that owns the same work class.
3. Check `skill-usage.json` for stale, overlapping, or rarely used skills worth merging, aliasing, pruning, or reshaping.
4. Extract candidate lessons as reusable target behavior rather than incident detail.
5. Keep candidates that change future behavior, routing, decisions, execution, or recall.
6. Choose the smallest correct destination using the priority list below.
7. Merge overlapping guidance into one canonical owner.
8. Rewrite the destination as compact target-state guidance.
9. Update existing same-topic memory-index transactions with dated bullets and monthly index keywords when evidence needs retrieval.
10. Prune stale short-term continuity records and move active state to the narrowest current owner.
11. Validate skill frontmatter after editing skills.
12. Report changed self-improve artifacts or one concise unchanged reason.

## Destination contract

Choose the first destination that satisfies the lesson's future-use contract:

1. **Prompt baseline:** the rule applies across most future turns and belongs in `agent_profile`, `user_profile`, or `core_doctrine`.
2. **Current skill:** the conversation used a skill and revealed a reusable gap in that skill.
3. **Umbrella skill:** a broader existing skill cleanly owns the work class.
4. **Skill `references/`:** reusable evidence, examples, command traces, or longer notes help future skill use while keeping `SKILL.md` concise.
5. **New reusable skill:** existing skills lack a clean home, and the lesson is a recurring class-level workflow, domain, or playbook.
6. **Memory-index pointer:** future lookup needs a compact dated handle to original evidence, chronology, or transaction context.
7. **Short-term continuity:** active temporary state still guides current work.
8. **Leave unchanged:** existing guidance already covers the lesson or the candidate adds clutter.

Fixed semantic destinations:

- `people-and-relationships`: person identity, address, title, or relationship context.
- `object-relationships`: non-person entity identity or relationships among entities.

## Surface contracts

### Prompt baselines

Location: `<agentDir>/self_improve/prompts/*.md`

- `agent_profile.md`: stable agent role, voice, behavior style, and standing expectations.
- `user_profile.md`: stable user identity and compact always-relevant user facts.
- `core_doctrine.md`: durable methodology, values, and decision rules.

Use prompt baselines for resident identity, user identity, and doctrine invariants. Put procedures, examples, durable domain facts, troubleshooting detail, and retrieval pointers in skills or memory-index destinations.

Rewrite a prompt slot as a compact canonical replacement. Keep one dense line per topic and shrink overgrown slots during review.

### Reusable skills

Location: `<agentDir>/self_improve/skills`

Use ordinary skills for reusable workflows, procedures, checklists, references, examples, and troubleshooting playbooks. Shape each skill around a recurring domain or workflow.

Put related lessons into the closest matching skill with clear headings. Use `references/` under the owning skill for detailed reusable evidence or examples that would make `SKILL.md` noisy. Keep `SKILL.md` as the operational entry point.

Create a new ordinary skill when the trigger is reusable, the scope is class-level, and existing skills lack a clean home.

### Memory-index pointers

`memory-index/SKILL.md` is the discoverable entry point for memory-index routing. Monthly directories under `memory-index/YYYY-MM/` contain index files and topic transactions such as `transactions/YYYY-MM-DD-topic.md`.

Memory-index transactions are retrieval pointers and compact evidence buckets. They support future lookup of original memory evidence while transcript archives remain the evidence source.

Use one evolving memory-index transaction for repeated same-topic evidence. Update the monthly index line with date ranges and keywords.

### Short-term continuity

`short-term-memory/SKILL.md` holds active temporary continuity. Keep current goals, blockers, handoff state, pending validation, and near next actions there while they guide current work. Merge, promote, or remove entries as they become durable guidance, evidence pointers, or completed work.

## Skill lifecycle

Follow `skill-creator` when creating or editing skills. Follow `rin-prompt-engineering` when writing prompts, descriptions, docs, task prompts, and reusable instructions.

Prefer broad reusable workflows over narrow fragments. Keep, merge, move, delete, or turn skills into intentional aliases according to their current value.

Use `disable-model-invocation: true` for skills that should remain explicit/manual reference material outside the always-visible model skill list. Delete obsolete aliases and stale fragments as cleanup work.

## Evaluation checks

Before reporting success, check the revised library against these prompt-engineering criteria:

- **Success criterion:** each changed line or file improves a named future behavior, routing decision, execution step, or recall path.
- **Instruction/data boundary:** original wording, chronology, and provenance stay retrievable through memory surfaces while self-improve stores distilled guidance.
- **Output contract:** the final report names changed artifacts and the behavior contract each artifact now owns.
- **Entropy:** duplicate, stale, conflicting, or misplaced guidance shrinks rather than spreads.
- **Trigger fit:** skills have descriptions that match the tasks that should load them.
- **Resident prompt fit:** prompt baselines contain only compact always-relevant behavior.
- **Retrieval fit:** memory-index pointers name enough date/topic/keyword context for later lookup.

## Final output

Report self-improve artifact changes:

- changed self-improve files with one short reason each;
- merged, moved, deleted, or pruned self-improve artifacts;
- cleanup performed without new guidance;
- one concise unchanged reason when the review leaves the library as-is;
- candidates routed to product work, memory retrieval, or owner clarification.
