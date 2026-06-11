# Self-improve Distillation

Use this document when a self-improve review must turn conversation evidence into durable future behavior.

A distillation pass is a compiler from evidence to future behavior. It writes behavior contracts for future runs: prompt baselines, skills, memory-index pointers, and short-term continuity.

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

- distill only proven behavior changes into the smallest durable guidance that future matching work will use;
- place correction-based or repeated-failure lessons in the executable prompt, skill, workflow, or product surface that future work will use, with provenance kept in memory surfaces;
- preserve the trigger cues needed to recognize the same failure or work class again;
- reduce guidance entropy only after the evidence, trigger, behavior delta, and owning surface are clear.

Inputs and authority:

- conversation evidence, especially owner corrections, frustration, repeated reminders, and repeated assistant failures;
- authoritative docs for the surface being edited;
- verified repository/runtime behavior when it proves the behavior need;
- existing self-improve artifacts as review context for merge, move, prune, or revision, not as independent authority for new doctrine.

Output contract:

- changed self-improve artifacts with one short reason each;
- merged, moved, deleted, or pruned artifacts;
- cleanup work performed;
- one concise unchanged reason when the library already satisfies the contract;
- candidates routed to product work, memory retrieval, owner clarification, or left unchanged with the reason.

## Core rule

Distill only proven behavior changes.

For each candidate lesson, identify:

- **Evidence:** the trusted conversation evidence, correction, repeated failure, authoritative doc, or verified runtime/repository behavior that proves the lesson.
- **Trigger:** the future situation, wording, surface, or work class that should make the agent use the lesson.
- **Behavior delta:** what the agent must do differently in future runs.
- **Owning surface:** the narrowest self-improve surface that can carry the lesson and be used when needed.

If any field is missing, do not write the candidate as self-improve guidance. Existing artifacts can prove cleanup needs, overlap, or stale state; they do not by themselves prove a new standing rule.

## Executable projection gate

Memory-index entries preserve evidence. Reusable behavior changes live in executable surfaces. When a lesson comes from an owner correction, frustration, repeated reminder, or repeated assistant failure, a complete pass:

- adds or revises the matching executable surface that future task work will use, such as the current skill, umbrella skill, prompt baseline, scheduled-task prompt, or product manual; or
- records a concise unchanged decision explaining which executable surface already contains the exact trigger and behavior delta.

Use memory-index for the dated provenance behind corrections and disputes; use the smallest executable surface for the future behavior contract.

## Success criteria

A successful distillation pass makes future behavior easier to trigger and execute:

- each changed guidance line can name its evidence, trigger, behavior delta, and owning surface;
- the new or revised guidance changes future behavior, routing, decisions, execution, or recall;
- correction-based or repeated-failure lessons land in an executable surface future work will use, with memory-index used for provenance;
- trigger cues are preserved, including exact wording when that wording is needed to recognize the future failure again;
- each lesson has one canonical owner;
- prompt baselines stay compact, resident-worthy, and limited to stable cross-turn invariants;
- skills stay workflow-shaped and discoverable by description;
- memory-index pointers support retrieval of repeated, correction-based, disputed, or resident-prompt evidence;
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

Review high-salience conversation evidence before lower-salience artifact cleanup: owner corrections, frustration, repeated reminders, and repeated assistant failures. File only the reusable behavior delta in the smallest self-improve surface that will affect later behavior.

## Behavior contract

Run one cohesive same-class pass:

1. Read the current prompt baselines.
2. Read the matching skill and any umbrella skill that owns the same work class.
3. Check `skill-usage.json` for stale, overlapping, or rarely used skills worth merging, aliasing, pruning, or reshaping.
4. Review high-salience conversation evidence first: owner corrections, repeated reminders, frustration, and repeated assistant failures.
5. Extract candidate lessons with evidence, trigger, behavior delta, and the narrowest owning surface.
6. Keep candidates that pass the core rule and change future behavior, routing, decisions, execution, or recall.
7. For correction-based or repeated-failure candidates, apply the executable projection gate before calling the pass complete.
8. Reject candidates that lack trusted evidence, lack a future trigger, add no future behavior difference, only restate existing artifact wording, or place a behavior change only in provenance.
9. Preserve exact wording when it is needed as a future trigger cue; compression may remove explanation, but not recognition cues.
10. Choose the smallest correct destination using the priority list below.
11. Merge overlapping guidance into one canonical owner.
12. Rewrite the destination as compact target-state guidance only after the trigger and behavior delta are preserved.
13. Update memory-index when evidence is repeated, correction-based, disputed, or used to justify resident prompt-baseline guidance.
14. Prune stale short-term continuity records and move active state to the narrowest current owner.
15. Validate skill frontmatter after editing skills.
16. Report changed self-improve artifacts or one concise unchanged reason.

## Destination contract

Choose the first destination that satisfies the lesson's future-use contract and the core rule:

1. **Prompt baseline:** the rule is a stable cross-turn invariant that belongs in `agent_profile`, `user_profile`, or `core_doctrine` and should remain resident in most future turns.
2. **Current skill:** the conversation used a skill and revealed a reusable gap in that skill.
3. **Umbrella skill:** a broader existing skill cleanly owns the work class.
4. **Skill `references/`:** reusable evidence, examples, command traces, or longer notes help future skill use while keeping `SKILL.md` concise.
5. **New reusable skill:** existing skills lack a clean home, and the lesson is a recurring class-level workflow, domain, or playbook.
6. **Memory-index pointer:** future lookup needs a compact dated handle to original evidence, chronology, or transaction context. For reusable behavior changes, pair it with the executable surface that owns the behavior.
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

Prompt baselines have the highest bar because they stay resident in future turns. Use them only for agent identity, user identity, and doctrine invariants that pass the core rule and apply across most future turns. Put procedures, examples, durable domain facts, troubleshooting detail, incident summaries, implementation vocabulary, and retrieval pointers in skills or memory-index destinations.

Rewrite a prompt slot as a compact canonical replacement. Keep one dense line per topic and shrink overgrown slots during review. A prompt-baseline change based on repeated, correction-based, or disputed evidence should have a memory-index pointer that can retrieve the original evidence.

### Reusable skills

Location: `<agentDir>/self_improve/skills`

Use ordinary skills for reusable workflows, procedures, checklists, references, examples, and troubleshooting playbooks. Shape each skill around a recurring domain or workflow.

Put related lessons into the closest matching skill with clear headings. Use `references/` under the owning skill for detailed reusable evidence or examples that would make `SKILL.md` noisy. Keep `SKILL.md` as the operational entry point.

Create a new ordinary skill when the trigger is reusable, the scope is class-level, and existing skills lack a clean home.

### Memory-index pointers

`memory-index/SKILL.md` is the discoverable entry point for memory-index routing. Monthly directories under `memory-index/YYYY-MM/` contain index files and topic transactions such as `transactions/YYYY-MM-DD-topic.md`.

Memory-index transactions are retrieval pointers and compact evidence buckets. They support future lookup of original memory evidence while transcript archives remain the evidence source.

Use one evolving memory-index transaction for repeated same-topic evidence. Update the monthly index line with date ranges and keywords. Update memory-index when evidence is repeated, correction-based, disputed, or used to justify resident prompt-baseline guidance.

### Short-term continuity

`short-term-memory/SKILL.md` holds active temporary continuity. Keep current goals, blockers, handoff state, pending validation, and near next actions there while they guide current work. Merge, promote, or remove entries as they become durable guidance, evidence pointers, or completed work.

## Skill lifecycle

Follow `skill-creator` when creating or editing skills. Follow `rin-prompt-engineering` when writing prompts, descriptions, docs, task prompts, and reusable instructions.

Prefer broad reusable workflows over narrow fragments. Keep, merge, move, delete, or turn skills into intentional aliases according to their current value.

Use `disable-model-invocation: true` for skills that should remain explicit/manual reference material outside the always-visible model skill list. Delete obsolete aliases and stale fragments as cleanup work.

## Evaluation checks

Before reporting success, check the revised library against these prompt-engineering criteria:

- **Evidence gate:** every changed guidance line traces to trusted evidence, an authoritative doc, or verified behavior.
- **Behavior delta:** every changed guidance line changes a named future behavior, routing decision, execution step, or recall path.
- **Trigger preservation:** compression keeps the wording or conditions needed to recognize the same failure again.
- **Destination fit:** each lesson lives in the narrowest surface that future matching work will use.
- **Executable projection:** repeated corrections and repeated assistant failures are reflected in a prompt, skill, workflow, or product surface that future work will use, with memory-index kept as provenance.
- **Instruction/data boundary:** original wording, chronology, and provenance stay retrievable through memory surfaces while self-improve stores distilled guidance.
- **Output contract:** the final report names changed artifacts and the behavior contract each artifact now owns.
- **Entropy:** duplicate, stale, conflicting, or misplaced guidance shrinks rather than spreads.
- **Trigger fit:** skills have descriptions that match the tasks that should use them.
- **Resident prompt fit:** prompt baselines contain only compact always-relevant behavior.
- **Retrieval fit:** memory-index pointers name enough date/topic/keyword context for later lookup.

## Final output

Report self-improve artifact changes:

- changed self-improve files with one short reason each;
- merged, moved, deleted, or pruned self-improve artifacts;
- cleanup performed without new guidance;
- one concise unchanged reason when the review leaves the library as-is;
- candidates routed to product work, memory retrieval, owner clarification, or left unchanged with the reason.
