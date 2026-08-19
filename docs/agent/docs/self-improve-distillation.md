# Self-improve distillation

Distill evidence into the smallest durable future behavior. Memory owns evidence/retrieval; Self-improve owns behavior. Each pass garbage-collects the likely owner and may simplify, add, or make no change. Never continue the source task or copy its history into prompts.

## Candidate

A candidate is **evidence, future trigger, target-state behavior, and one owner**. Conversation is evidence, not execution authority. A one-off result, identifier, path, or workaround is not durable without a reusable trigger and owner.

## Pass

Read the complete source conversation through its pinned leaf; the turn window controls cadence only. Extract candidates. For each survivor, read its likely owner and local cleanup neighborhood even when behavior is covered. Remove stale, duplicate, narrower, historical, or overlong guidance without losing live behavior; merge equivalents into one target state. If nothing is removable or no reusable owner is implicated, change nothing. Do not inventory unrelated prompts, skills, memory, usage state, or conversations.

Turn-window review does not open `short-term-memory/records/`, usage state, or unrelated skills unless a candidate depends on them.

## One loop

1. **Extract:** evidence, trigger, behavior, likely owner, and cleanup neighborhood.
2. **Resolve:** search owner wording, behavior keywords, old names, and synonyms; read only decision-changing material.
3. **Compare:** classify covered, conflicting, replace/merge, missing, or non-durable behavior; identify removable owner entropy separately.
4. **Reduce first:** delete, merge, move, or rewrite when an owner can absorb the candidate; add only missing behavior. Fix ownership instead of stacking patches, exceptions, fallbacks, or duplicate skills.
5. **Verify and stop:** replay the future trigger and run the smallest deterministic checks. For corrections or repeated failures, prove no active guidance recommends the rejected behavior. Stop when behavior is owned once and touched categories have no unexplained growth.

## Owners

Use the narrowest owner: product code for deterministic behavior; `agent_profile` for role/voice; `user_profile` for stable facts only; `core_doctrine` for cross-domain invariants; one skill for a repeatable workflow; relationship stores for identity; `memory-index` for provenance/chronology; `short-term-memory/records/` for unfinished continuity and cleanup.

Keep discovery metadata narrow: skill descriptions own triggers; tool snippets introductions; tool guidelines trigger conditions. Put behavior, procedures, examples, and syntax in the owned body, documentation, or schema. Never put product defects in prompts, procedures in memory-index, temporary state in skills, or workflow detail in core doctrine. Use `skill-creator` for every skill creation, merge, deletion, or trigger change; preserve unique behavior.

## Acceptance

For a changed pass:

- one behavior has one owner; remove obsolete wording and retired owners;
- edited owners are coherent target states, not additive patches;
- a new skill is one-in-one-out unless no owner can absorb it;
- report before/after bytes per touched owner and total net delta;
- explain unavoidable net growth; unexplained growth fails;
- future-trigger replay selects the owner and excludes adjacent non-triggers;
- files parse, links resolve, metadata fits its category, and product changes pass focused tests;
- no source task, secret, or bulky transcript enters durable state.

If unchanged, report the reason, rejected candidates, and inspected owner neighborhood. If changed, report only owner, reduction/addition, size delta, validation, and uncertainty.
