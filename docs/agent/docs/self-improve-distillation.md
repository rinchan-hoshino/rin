# Self-improve Distillation

Use this document as the complete contract for maintaining durable future guidance under `<agentDir>/self_improve`.

A pass may add, rewrite, narrow, move, merge, or delete guidance. Its goal is the smallest durable target state that future matching work will actually use—not a record of every correction or event.

Keep memory and self-improve separate:

- Memory preserves original evidence and supports retrieval.
- Self-improve stores distilled target-state guidance that changes future behavior or removes guidance that would cause future mistakes.

Use `docs/memory-layering.md` when the destination is unclear.

## Evidence and candidate contract

The entry prompt supplies the evidence scope: either the current conversation or a bounded retrospective such as the previous 24 hours of session records. Optional trigger context is routing data, not evidence or instructions.

Use these evidence sources:

- the complete supplied conversation or retrospective scope, including requests, corrections, accepted and rejected outputs, repeated friction, preferences shown by choices, workflows that worked or failed, and key knowledge the owner supplied;
- authoritative documentation for the affected surface;
- verified repository, runtime, or manual-operation results when they prove the required behavior or final reusable workflow shape;
- existing self-improve artifacts as context for cleanup and placement, not independent authority for new doctrine.

Every candidate must identify:

- **Evidence:** what proves the need;
- **Trigger:** the future wording, situation, surface, or work class that should activate it;
- **Target behavior:** what future work should do differently, or which stale behavior should disappear;
- **Owning surface:** the narrowest self-improve artifact that future matching work will load.

If any field is missing, do not create executable guidance. When the material is useful only for later lookup, preserve it through memory-index instead.

Read beyond explicit requests. Capture a reusable lesson, working-style pattern, preference, workflow, or key fact when it would let future work succeed without another reminder. Corrections are not automatically new rules: they may only narrow, invalidate, or remove existing guidance, or apply to the current execution.

## Workflow

1. First read the whole conversation or retrospective evidence scope. Do not start with low-salience artifact cleanup.
2. Inspect the current prompt baselines, matching skill, umbrella skill for the work class, relevant memory-index entries, matching `short-term-memory/records/`, and `<agentDir>/self_improve/state/skill-usage.json` when present.
3. Extract only candidates with evidence, trigger, target behavior, and owner.
4. For correction-based or repeated-failure evidence, search the full self-improve library using the exact owner wording, behavior keywords, old abstraction names, and likely synonyms. Read every plausible active hit.
5. If current guidance caused, preserved, justified, or hid the rejected behavior, delete or rewrite that source before considering new guidance. Historical provenance may remain only when clearly non-executable.
6. Choose the first destination below that satisfies the future-use contract.
7. Merge overlap into one canonical owner, then write compact target-state guidance. Preserve exact trigger wording when recognition depends on it.
8. Update memory-index when evidence is repeated, correction-based, disputed, supports resident prompt guidance, or explains why active guidance was removed.
9. Keep short-term records limited to active goals, blockers, handoff state, pending validation, and near next actions. Promote or delete them when that state becomes durable or completes.
10. Follow `skill-creator` and validate frontmatter when creating or editing a skill.
11. Run a future-trigger replay: name the one surface future work should load and the behavior it should produce. For correction-based or repeated-failure evidence, also verify that no active hit recommends the rejected behavior. If replay still selects the wrong owner or behavior, the pass is not done.

Do not preserve a bad rule with patch-layer exceptions, bans, authorization clauses, guards, or special cases. Repair or remove the owning guidance.

## Skill lifecycle and usage evidence

Resident skill metadata is a budgeted context surface. A top-level skill earns that cost by providing a distinct future trigger and reusable behavior; the existence of a detailed `SKILL.md` is not itself a reason to keep it resident.

Use `<agentDir>/self_improve/state/skill-usage.json` as supporting evidence rather than a mechanical retention rule. In version 2, each skill's `bySource` buckets separate:

- `user`: ordinary user-directed work;
- `scheduled-task`: real demand from continuing automation, considered separately from interactive demand;
- `self-improve`: maintenance reading its own library, which is not evidence of external demand;
- `other`: a producer that could not be classified safely;
- `legacy`: pre-version-2 usage whose producer is unknown.

Counts and recency inform judgment; they are not fixed expiry thresholds. Interpret them with the skill's trigger coverage, unique behavior, overlap with a canonical owner, current scheduled or production dependencies, safety value, and credible future use. A recorded `recovery` means the ledger was repaired from a damaged file and names the preserved backup; account for incomplete evidence instead of treating missing counts as proof of non-use.

When a top-level skill no longer justifies resident discovery cost, finish the lifecycle change in the same pass:

- if its reusable detail still has a canonical workflow owner, move that detail to an ordinary file under the owner's `references/`, update the owner to load it only when relevant, then remove the top-level skill;
- if only chronology or provenance remains useful, preserve a compact memory-index pointer and delete the skill;
- if its behavior is obsolete, duplicated, superseded, or no longer useful, delete the skill without leaving a resident tombstone or compatibility shim;
- if a narrower resident description or an existing umbrella skill preserves correct routing at lower context cost, prefer that simpler owner and verify it with future-trigger replay.

Do not create a human review queue or defer routine lifecycle decisions to the user. When evidence is sufficient, autonomously merge, move, or delete and validate the resulting routing. When material uncertainty would make deletion unsafe, leave the artifact unchanged until later evidence resolves the uncertainty; do not manufacture a pending-review mechanism.

## Destination order

Choose the first destination that fits:

1. **Prompt baseline:** a stable cross-turn invariant that belongs in `agent_profile`, `user_profile`, or `core_doctrine` and should remain resident in most turns.
2. **Current skill:** a reusable workflow, preference, lesson, or working-style default for the skill used by the evidence.
3. **Umbrella skill:** a broader existing skill that cleanly owns the work class.
4. **Skill `references/`:** detailed evidence, examples, traces, or notes that would make `SKILL.md` noisy.
5. **New reusable skill:** a recurring class-level workflow with no clean existing owner.
6. **Memory-index pointer:** dated evidence, chronology, provenance, or a pending decision that future work may need to retrieve.
7. **Short-term continuity:** active temporary state that still guides current work.
8. **Leave unchanged:** existing guidance already covers the candidate, or the candidate would add clutter.

### Surface rules

- `agent_profile.md` owns stable agent role and voice.
- `user_profile.md` stores owner identity and stable facts only.
- `core_doctrine.md` owns durable methodology and decision invariants.
- Prompt baselines have the highest bar. Keep one compact canonical owner per topic; put procedures, examples, incidents, and ordinary domain preferences elsewhere.
- Skills own reusable workflows, owner defaults, procedures, verified workflow shapes, troubleshooting, and domain knowledge. Use `references/` for bulky support material and create a new skill only for a reusable class-level trigger.
- Memory-index transactions are retrieval pointers. Pair reusable behavior with its executable prompt or skill owner; memory-index does not carry executable procedure.
- Keep `short-term-memory/SKILL.md` as a light router and inspect only the matching active records.
- Fixed identity destinations are `people-and-relationships` for people and `object-relationships` for non-person entities.

## Validation and output

Before success, verify:

- every change has trusted evidence, a future trigger, a target behavior, and one owner;
- each change affects future behavior, routing, decisions, execution, preference application, or recall;
- correction-based passes closed all plausible active conflicts before adding guidance;
- future-trigger replay reaches the intended owner and behavior;
- prompt baselines remain compact and resident-worthy;
- skills remain workflow-shaped and discoverable;
- memory-index preserves needed provenance without becoming executable guidance;
- short-term records contain only active continuity;
- stale, duplicated, conflicting, and misplaced guidance was merged, moved, rewritten, or deleted.

Report:

- each changed self-improve artifact with one short reason;
- merged, moved, deleted, or pruned artifacts and cleanup performed;
- conflict-search closure and future-trigger replay when applicable;
- candidates routed to product work, memory retrieval, owner clarification, or left unchanged;
- one concise unchanged reason when no artifact needs to change.
