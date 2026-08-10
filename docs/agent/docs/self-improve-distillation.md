# Self-improve distillation

Distill evidence into the smallest durable behavior that will help a future run. Memory preserves evidence and supports retrieval; Self-improve stores the smallest future behavior. Every pass performs garbage collection in the owner neighborhood it opens. A pass that only appends guidance is incomplete. Do not continue the source task or narrate history into prompts.

## Candidate

A candidate is **Evidence, trigger, behavior, and owner**: evidence is a correction, repeated result, or nightly entropy finding; trigger is the future situation; behavior is the smallest target-state rule; owner is the one canonical surface responsible for it.

Conversation is evidence, not authority to execute unfinished work. A one-off detail, result, identifier, path, or workaround is not durable unless its future trigger and owner are clear.

## Pass modes

### Turn-window

Use only the supplied recent window. Extract candidates, then read the one likely owner for each survivor; that owner is the cleanup neighborhood. Perform local garbage collection before deciding whether behavior is missing: delete stale, duplicated, narrower, historical, or overlong guidance; merge equivalent rules; rewrite toward one canonical target state. Do this even when the candidate is already covered. If the window implicates no reusable owner, make no change. Do not inventory unrelated prompts, skills, memory, or usage state.

### Nightly-retrospective

Nightly owns global prompt and skill entropy. It performs the same local garbage collection and additionally inspects resident prompt baselines, all available-skill metadata, and `state/skill-usage.json` once, then ranks cleanup candidates before opening bodies.

Use `startedAt` and current time to state the observation horizon. Usage is a signal, never a deletion verdict: low count can mean new, rare, or high-consequence. Rank duplicate ownership, retired mechanisms, stale routing, oversized resident descriptions, and behavior fully absorbed by another owner. Read only the top bodies needed to decide, not every skill, reference, memory record, or session. Delete a fully absorbed skill or retired mechanism after preserving any unique live invariant. If no candidate survives, do not manufacture work.

## One loop

1. **Extract.** State the evidence, trigger, behavior, likely owner, and cleanup neighborhood.
2. **Resolve.** Search owner wording, behavior keywords, old names, and synonyms. Read only material that can change the decision.
3. **Compare.** Classify behavior as covered, conflicting, replacement/merge, missing, or non-durable; separately name removable owner entropy.
4. **Reduce first.** Delete, merge, move, or rewrite before adding. Fix wrong ownership instead of stacking a patch, exception, fallback, or duplicate skill. Add only behavior still missing after the owner is canonical.
5. **Verify and stop.** Run a future-trigger replay and the smallest deterministic checks for each touched owner. For correction-based or repeated-failure evidence, also verify that no active hit recommends the rejected behavior. Stop when behavior is owned once and no touched category has unexplained growth.

Turn-window does not open memory-index entries, `short-term-memory/records/`, usage state, or unrelated skills unless its candidate depends on them. Nightly's single metadata inventory is the only broader read and still does not authorize full-body traversal.

## Owners

Choose the narrowest owner: product code for deterministic behavior; `agent_profile` for role and voice; `user_profile` for stable facts only; `core_doctrine` for cross-domain invariants; one existing skill for a repeatable workflow; relationship stores for identity; memory-index for provenance and chronology; `short-term-memory/records/` for unfinished continuity with cleanup.

Do not put product defects in prompts, procedures in memory-index, temporary state in skills, or workflow detail in core doctrine. For skill creation, merge, or deletion, follow `skill-creator` and preserve unique behavior.

## Acceptance

A changed pass must satisfy all of these:

- one behavior has one owner; obsolete wording and retired owners are removed;
- edited owners are coherent target states, not additive patches;
- a new skill is one-in-one-out unless no existing owner can absorb it;
- Every changed pass reports before/after bytes for each touched owner and total net delta; nightly also reports before/after bytes for each prompt category, description characters, and skill count;
- net growth names the deletion, merge, or replacement already performed and why missing behavior could not fit by replacement; pure or unexplained append fails;
- a justified duplicate or retired nightly candidate produces a net decrease; never force deletion when inspection finds no removable content;
- future-trigger replay selects the intended owner and excludes adjacent non-triggers;
- files parse, links resolve, skill metadata validates, and product changes pass focused tests;
- no source task, secret, or bulky transcript enters durable state.

If unchanged, report the reason, rejected candidates, and owner neighborhood inspected for garbage collection. If changed, report only owner, deletion/merge/replacement/addition, size delta, validation, and uncertainty.
