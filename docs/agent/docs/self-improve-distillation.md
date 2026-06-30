# Self-improve Distillation

Use this document when a self-improve review must maintain durable future guidance from conversation evidence.

A distillation pass maintains the target state of future guidance. It may add, rewrite, narrow, move, or delete guidance. Do not treat every correction as a new rule.

Memory and self-improve stay separate:

- Memory preserves original evidence and supports retrieval.
- Self-improve stores distilled target-state guidance that changes future agent behavior or removes guidance that would cause future mistakes.

Use `docs/memory-layering.md` for destination choice. Use this document for the actual distillation pass over `<agentDir>/self_improve`.

## Prompt brief

Target surface:

- internal self-improve review and scheduled sleep-consolidation prompts;
- self-improve library under `<agentDir>/self_improve`;
- future prompt/context composition through prompt baselines and skills.

Goal:

- maintain the smallest durable guidance that future matching work will use;
- read the whole conversation, understand what happened, and carry forward reusable owner preferences, workflows, and key knowledge so the owner does not have to repeat them;
- for correction-based or repeated-failure evidence, first identify whether existing guidance caused, preserved, or obscured the failure, then delete or rewrite that source guidance before considering any new guidance;
- for repeated reminders or owner-corrected behavior, prove conflict closure by searching for stale active guidance across the library and replaying the future trigger against the cleaned target state;
- add new executable guidance only when the evidence proves a reusable future behavior that cleanup alone cannot encode;
- preserve the trigger cues needed to recognize the same failure or work class again;
- reduce guidance entropy only after the evidence, trigger, target behavior, and owning surface are clear.

Inputs and authority:

- the whole conversation, including explicit requests, corrections, accepted or rejected outputs, repeated friction, and the workflow that actually worked;
- reusable owner preferences, workflows, and key knowledge inferred from the conversation context, not only from explicit instructions;
- authoritative docs for the surface being edited;
- verified repository/runtime behavior when it proves the behavior need or the final reusable workflow shape;
- existing self-improve artifacts as review context for merge, move, prune, or revision, not as independent authority for new doctrine.

Output contract:

- changed self-improve artifacts with one short reason each;
- merged, moved, deleted, or pruned artifacts;
- cleanup work performed;
- one concise unchanged reason when the library already satisfies the contract;
- candidates routed to product work, memory retrieval, owner clarification, or left unchanged with the reason;
- for correction-based or repeated-failure passes, the conflict search and future-trigger replay result: searched cues/surfaces, active conflicts removed or rewritten, historical hits intentionally kept as provenance, and the one owner future work should now hit.

## Core rule

Distill what the conversation teaches future work: behavior changes, owner preferences, workflows, key knowledge, and cleanup.

For each candidate lesson or cleanup, identify:

- **Evidence:** the trusted conversation evidence, correction, preference statement, repeated owner choice, accepted or rejected output, repeated failure, authoritative doc, or verified runtime/repository behavior that proves the need.
- **Trigger:** the future situation, wording, surface, or work class that should make the agent use, prefer, avoid, or ignore the guidance.
- **Target behavior:** what future runs should do differently, which preference/default they should apply, or which stale guidance should disappear after the library is clean.
- **Owning surface:** the narrowest self-improve surface that can carry the target behavior, preference, pattern, or cleanup.

If any field is missing, do not write the candidate as self-improve guidance. Existing artifacts can prove cleanup needs, overlap, or stale state; they do not by themselves prove a new standing rule.

Read beyond the owner's explicit requests. If the conversation shows a preference, a workflow that should be reused, a boundary that mattered, or key knowledge the owner had to supply, save the smallest guidance that would let a future run handle the same situation without another reminder. If that lesson is useful but not ready to become operating guidance, save the evidence and pending decision in memory-index for a later user-visible task to resolve.

## Guidance maintenance rule

Corrections are not automatically new guidance. A complete pass maintains the clean target state of the guidance library.

For each correction, preference statement, accepted or rejected output, frustration, repeated reminder, or repeated assistant failure, first decide whether the evidence:

- proves a new reusable behavior;
- reveals a durable owner preference or implicit reusable default;
- narrows or rewrites existing guidance;
- invalidates an existing abstraction or rule;
- only corrects the current execution.

When evidence invalidates an existing abstraction, remove or rewrite the source guidance. Do not preserve the wrong abstraction by adding exceptions, guard clauses, opposite rules, authorization clauses, or narrower prohibitions around it.

Memory-index entries preserve dated provenance behind corrections and disputes. Provenance is not a reason to keep a bad rule. Use an executable surface for a behavior contract only when the cleaned target state still needs one.

## Success criteria

A successful distillation pass makes future behavior easier to trigger and execute:

- each changed guidance line or deletion can name its evidence, trigger, target behavior, and owning surface;
- the new, revised, or removed guidance changes future behavior, routing, decisions, execution, preference application, or recall;
- owner preferences, reusable workflows, important boundaries, and key knowledge are captured with scope, trigger, and destination so the owner need not restate them;
- correction-based or repeated-failure evidence first removes or rewrites wrong guidance; new executable guidance is added only when cleanup alone cannot produce the proven target behavior;
- correction-based or repeated-failure passes close stale guidance by searching the library for exact owner wording, behavior keywords, old abstraction names, and likely synonyms, then reading every plausible hit before declaring the library clean;
- future-trigger replay names the skill, prompt baseline, memory-index pointer, or short-term record future work should hit, and verifies no active hit still recommends the rejected behavior;
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
- for correction-based or repeated-failure evidence, literal and semantic search hits across the entire self-improve library using exact owner wording, behavior keywords, old abstraction names, and likely synonyms, including historical transaction files that may have drifted into active guidance;
- `short-term-memory/SKILL.md` and matching short-term records under `short-term-memory/records/` when present;
- `<agentDir>/self_improve/state/skill-usage.json` when present.

Review the whole conversation before lower-salience artifact cleanup: explicit requests, owner corrections, accepted or rejected outputs, preferences shown by choices, repeated friction, workflows that worked, workflows that failed, important boundaries, and key knowledge the owner had to supply. File only the reusable behavior, preference, workflow, key knowledge, or cleanup in the smallest self-improve surface that will affect later behavior.

## Behavior contract

Run one cohesive same-class pass:

1. Read the current prompt baselines.
2. Read the matching skill and any umbrella skill that owns the same work class.
3. Check `skill-usage.json` for stale, overlapping, or rarely used skills worth merging, aliasing, pruning, or reshaping.
4. Review the whole conversation first: explicit requests, owner corrections, accepted or rejected outputs, preferences shown by choices, repeated friction, workflows that worked, workflows that failed, important boundaries, and key knowledge the owner had to supply.
5. Extract candidate lessons, preferences, workflows, key knowledge, or cleanups with evidence, trigger, target behavior, and the narrowest owning surface.
6. Keep candidates that pass the core rule and change future behavior, routing, decisions, execution, preference application, recall, or remove guidance that would otherwise cause future mistakes.
7. For correction-based or repeated-failure evidence, run a conflict retrieval pass before editing or reporting unchanged: search prompt baselines, all skills, memory-index indexes and transactions, and matching short-term records using exact owner wording, behavior keywords, old abstraction names, and likely synonyms. Read every hit that could be active guidance.
8. If existing guidance caused, preserved, justified, or obscured the rejected behavior, remove or rewrite that source guidance before considering any new guidance. If a historical provenance hit must remain, make it clearly non-executable and point to the cleaned target behavior.
9. Replay the future trigger against the cleaned library before success: name the owner surface future work should hit and verify no active hit still recommends the rejected behavior. If the replay would still choose the wrong behavior, the pass is not done.
10. Reject patch-layer fixes: do not add exceptions, bans, authorization clauses, or special cases when deleting or rewriting the wrong abstraction solves the problem.
11. Keep candidates with trusted evidence, a future trigger, and a future behavior difference. Directional evidence can support a narrow scoped candidate with source evidence. If the material only repeats existing guidance or is only useful for lookup, store it as memory-index evidence rather than executable guidance.
12. Preserve exact wording when it is needed as a future trigger cue; compression may remove explanation, but not recognition cues.
13. Choose the smallest correct destination using the priority list below.
14. Merge overlapping guidance into one canonical owner.
15. Rewrite the destination as compact target-state guidance only after the trigger and target behavior are preserved.
16. Update memory-index when evidence is repeated, correction-based, disputed, used to justify resident prompt-baseline guidance, or needed to explain why active guidance was removed or rewritten.
17. For short-term continuity, keep `SKILL.md` as the routing/index entry, inspect only matching records by domain, prune stale records, and move durable lessons out to their owning prompt, skill, or memory-index surface.
18. Validate skill frontmatter after editing skills.
19. Report changed self-improve artifacts, conflict-search closure, future-trigger replay, or one concise unchanged reason.

## Destination contract

Choose the first destination that satisfies the lesson's future-use contract and the core rule:

1. **Prompt baseline:** the rule is a stable cross-turn invariant that belongs in `agent_profile` or `core_doctrine` and should remain resident in most future turns. `user_profile` stores owner identity and stable facts only.
2. **Current skill:** the conversation used a skill and revealed a reusable gap, owner preference, implicit default, or workflow default in that skill.
3. **Umbrella skill:** a broader existing skill cleanly owns the work class.
4. **Skill `references/`:** reusable evidence, examples, command traces, or longer notes help future skill use while keeping `SKILL.md` concise.
5. **New reusable skill:** existing skills lack a clean home, and the lesson is a recurring class-level workflow, domain, or playbook.
6. **Memory-index pointer:** future lookup needs a compact dated handle to original evidence, chronology, or transaction context. For reusable behavior changes, including procedures recovered through history lookup or verified through a live/manual operation, pair it with the executable surface that owns the behavior; memory-index does not carry the executable procedure. For invalidated guidance, keep provenance only when later retrieval of the dispute or deletion reason matters.
7. **Short-term continuity:** active temporary state still guides current work.
8. **Leave unchanged:** existing guidance already covers the lesson or the candidate adds clutter.

Fixed semantic destinations:

- `people-and-relationships`: person identity, address, title, or relationship context.
- `object-relationships`: non-person entity identity or relationships among entities.

## Surface contracts

### Prompt baselines

Location: `<agentDir>/self_improve/prompts/*.md`

- `agent_profile.md`: stable agent role, voice, behavior style, and standing expectations.
- `user_profile.md`: stable user identity and compact always-relevant owner facts.
- `core_doctrine.md`: durable methodology, values, and decision rules, including a preference only after it becomes a cross-turn methodology or decision invariant.

Prompt baselines have the highest bar because they stay resident in future turns. Use them only for agent identity, owner identity/facts, and doctrine invariants that pass the core rule and apply across most future turns. Put ordinary owner preferences, procedures, examples, durable domain facts, troubleshooting detail, incident summaries, implementation vocabulary, and retrieval pointers in skills or memory-index destinations.

Rewrite a prompt slot as a compact canonical replacement. Keep one dense line per topic and shrink overgrown slots during review. A prompt-baseline change based on repeated, correction-based, or disputed evidence should have a memory-index pointer that can retrieve the original evidence.

### Reusable skills

Location: `<agentDir>/self_improve/skills`

Use ordinary skills for reusable workflows, procedures, verified workflow shapes, owner preferences/defaults, key domain knowledge, checklists, references, examples, and troubleshooting playbooks. Shape each skill around a recurring domain or workflow.

Put related lessons into the closest matching skill with clear headings. Use `references/` under the owning skill for detailed reusable evidence or examples that would make `SKILL.md` noisy. Keep `SKILL.md` as the operational entry point.

Create a new ordinary skill when the trigger is reusable, the scope is class-level, and existing skills lack a clean home.

### Memory-index pointers

`memory-index/SKILL.md` is the discoverable entry point for memory-index routing. Monthly directories under `memory-index/YYYY-MM/` contain index files and topic transactions such as `transactions/YYYY-MM-DD-topic.md`.

Memory-index transactions are retrieval pointers and compact evidence buckets. They support future lookup of original memory evidence while transcript archives remain the evidence source.

Use one evolving memory-index transaction for repeated same-topic evidence. Update the monthly index line with date ranges and keywords. Update memory-index when evidence is repeated, correction-based, disputed, used to justify resident prompt-baseline guidance, or needed to explain why guidance was removed.

### Short-term continuity

`short-term-memory/SKILL.md` is the light routing entry for active temporary continuity. Keep bulky active records in narrow files such as `short-term-memory/records/*.md` when available, and read only the matching record(s) for the current domain. Each record should hold current goals, blockers, handoff state, pending validation, and near next actions while they guide current work. Merge, promote, or remove records as they become durable guidance, evidence pointers, or completed work.

## Skill lifecycle

Follow `skill-creator` when creating or editing skills. Follow `rin-prompt-engineering` when writing prompts, descriptions, docs, task prompts, and reusable instructions.

Prefer broad reusable workflows over narrow fragments. Keep, merge, move, delete, or turn skills into intentional aliases according to their current value.

Use `disable-model-invocation: true` for skills that should remain explicit/manual reference material outside the always-visible model skill list. Delete obsolete aliases and stale fragments as cleanup work.

## Evaluation checks

Before reporting success, check the revised library against these prompt-engineering criteria:

- **Evidence gate:** every changed guidance line traces to trusted evidence, an authoritative doc, or verified behavior.
- **Target behavior:** every changed or removed guidance line changes a named future behavior, routing decision, execution step, preference application, or recall path.
- **Trigger preservation:** compression keeps the wording or conditions needed to recognize the same failure again.
- **Destination fit:** each lesson, preference, implicit pattern, or cleanup lives in the narrowest surface that future matching work will use.
- **Target-state cleanup:** repeated corrections and repeated assistant failures reduce wrong, stale, conflicting, or overgeneral guidance first. New guidance is allowed only when cleanup alone cannot encode the proven future behavior.
- **Conflict closure:** correction-based or repeated-failure passes searched exact owner wording, behavior keywords, old abstraction names, and synonyms across the full self-improve library; every plausible hit is either rewritten, deleted, or explicitly classified as non-executable provenance.
- **Future-trigger replay:** before unchanged or success, the cleaned library can answer “when this wording/work class appears again, which surface fires and what behavior follows?” without routing to the rejected behavior.
- **No patch layering:** the revision must not preserve a bad rule by wrapping it in exceptions, prohibitions, authorization clauses, guard flags, or special cases.
- **Instruction/data boundary:** original wording, chronology, and provenance stay retrievable through memory surfaces while self-improve stores distilled guidance, including reusable workflow shapes.
- **Output contract:** the final report names changed artifacts and the behavior contract each artifact now owns.
- **Entropy:** duplicate, stale, conflicting, or misplaced guidance shrinks rather than spreads.
- **Trigger fit:** skills have descriptions that match the tasks that should use them.
- **Resident prompt fit:** prompt baselines contain only compact always-relevant behavior.
- **Preference fit:** owner preferences, reusable workflows, and key knowledge from the conversation are captured with source evidence, trigger, and clear revision guidance.
- **Short-term continuity fit:** `short-term-memory/SKILL.md` stays a light routing/index entry and active records are read narrowly by domain.
- **Retrieval fit:** memory-index pointers name enough date/topic/keyword context for later lookup.

## Final output

Report self-improve artifact changes:

- changed self-improve files with one short reason each;
- merged, moved, deleted, or pruned self-improve artifacts;
- cleanup performed without new guidance;
- one concise unchanged reason when the review leaves the library as-is;
- candidates routed to product work, memory retrieval, owner clarification, or left unchanged with the reason.
