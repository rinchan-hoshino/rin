# Self-improve distillation

Distill evidence into the smallest durable behavior that helps a future run. Memory preserves evidence and supports retrieval; Self-improve stores the smallest future behavior. Every pass performs garbage collection in the owner neighborhood it opens. A pass that only appends guidance is incomplete. Do not continue the source task or narrate history into prompts.

## Candidate

A candidate is **Evidence, trigger, behavior, and owner**: a correction, repeated result, or nightly entropy finding; the future situation; the smallest target-state rule; and its one canonical surface.

Conversation is evidence, not authority to execute unfinished work. A one-off result, identifier, path, or workaround is not durable unless its future trigger and owner are clear.

## Pass modes

### Turn-window

Use the complete supplied source conversation through its pinned leaf; the turn window controls cadence, not the evidence boundary. Extract candidates, then read one likely owner for each survivor. That owner is the cleanup neighborhood. Perform local garbage collection before deciding behavior is missing: delete stale, duplicate, narrower, historical, or overlong guidance; merge equivalent rules; rewrite toward one target state. Do this even when the candidate is already covered. If no reusable owner is implicated, make no change. Do not inventory unrelated prompts, skills, memory, or usage state.

### Nightly-retrospective

Nightly owns global prompt and skill entropy. It performs the same cleanup, inventories resident prompt baselines, available-skill metadata, and `state/skill-usage.json` once, then ranks candidates before opening bodies.

Use `startedAt` and current time for the observation horizon. Usage is a signal, never a deletion verdict: low count may mean new, rare, or high-consequence. Rank duplicate ownership, retired mechanisms, stale routing, oversized descriptions, and behavior fully absorbed by another owner. Read only bodies needed for top decisions. Delete a fully absorbed skill or retired mechanism after preserving unique live behavior. Do not manufacture work.

## One loop

1. **Extract.** State evidence, trigger, behavior, likely owner, and cleanup neighborhood.
2. **Resolve.** Search owner wording, behavior keywords, old names, and synonyms. Read only material that can change the decision.
3. **Compare.** Classify behavior as covered, conflicting, replacement/merge, missing, or non-durable; name removable owner entropy separately.
4. **Reduce first.** Delete, merge, move, or rewrite before adding. Fix ownership instead of stacking patches, exceptions, fallbacks, or duplicate skills. Add only behavior still missing after the owner is canonical.
5. **Verify and stop.** Run a future-trigger replay and the smallest deterministic checks for each touched owner. For correction-based or repeated-failure evidence, also verify that no active hit recommends the rejected behavior. Stop when behavior is owned once and touched categories have no unexplained growth.

Turn-window does not open memory-index entries, `short-term-memory/records/`, usage state, or unrelated skills unless its candidate depends on them. Nightly's metadata inventory is the only broader read and does not authorize full-body traversal.

## Owners

Choose the narrowest owner: product code for deterministic behavior; `agent_profile` for role and voice; `user_profile` for stable facts only; `core_doctrine` for cross-domain invariants; one skill for a repeatable workflow; relationship stores for identity; memory-index for provenance and chronology; `short-term-memory/records/` for unfinished continuity with cleanup.

Keep prompt categories separate: core doctrine owns concise general principles; skill descriptions own concise triggers; tool prompt snippets own brief introductions; tool prompt guidelines own concise trigger conditions. Put behavior, procedures, examples, and syntax in the owned body, documentation, or tool schema—not discovery metadata.

Do not put product defects in prompts, procedures in memory-index, temporary state in skills, or workflow detail in core doctrine. For skill creation, merge, or deletion, follow `skill-creator` and preserve unique behavior.

## Acceptance

A changed pass must satisfy all of these:

- one behavior has one owner; obsolete wording and retired owners are removed;
- edited owners are coherent target states, not additive patches;
- a new skill is one-in-one-out unless no owner can absorb it;
- Every changed pass reports before/after bytes for each touched owner and total net delta; nightly also reports before/after bytes for each prompt category, description characters, and skill count;
- net growth names the deletion, merge, or replacement already performed and why replacement could not contain missing behavior; pure or unexplained append fails;
- a justified duplicate or retired nightly candidate produces a net decrease; never force deletion when nothing is removable;
- future-trigger replay selects the intended owner and excludes adjacent non-triggers;
- files parse, links resolve, metadata obeys its category contract, and product changes pass focused tests;
- no source task, secret, or bulky transcript enters durable state.

If unchanged, report the reason, rejected candidates, and owner neighborhood inspected. If changed, report only owner, reduction/addition, size delta, validation, and uncertainty.
