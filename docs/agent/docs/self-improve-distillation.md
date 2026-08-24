# Self-improve distillation

Compress each pass within its resident budget: keep minimal guidance with highest future value. Memory owns evidence/retrieval; Self-improve owns behavior. Each pass garbage-collects the owner and may simplify, add, or make no change. Never continue the source task or copy its history into prompts.

## Candidate

Focus on:

- **User requirements and preferences:** durable goals, constraints, tradeoffs, and preferences; later intent replaces incompatible earlier intent.
- **Reusable workflows:** recurring triggers, decisions, steps, boundaries, and acceptance; omit task-specific state and logs.
- **Lessons learned:** outcomes or corrections that improve future judgment or action; retain improved behavior, not incident or patch history.

A candidate needs **evidence, future trigger, target-state behavior, and one owner**. Rank it by applicability, reuse likelihood, observed impact, evidence strength, and resident cost. Task-specific results need a recurring trigger.

## Pass

Read the complete source conversation through its pinned leaf; the turn window controls cadence only. For each survivor, read its likely owner and local cleanup neighborhood even when behavior is covered. Open unrelated surfaces only when a candidate depends on them.

## One loop

1. **Extract:** class, evidence, trigger, behavior, and likely owner.
2. **Resolve:** search the owner and cleanup neighborhood; read only decision-changing material.
3. **Compare:** rank future value against resident cost; classify covered, conflicting, replace/merge, missing, or non-durable.
4. **Compress:** delete, merge, move, or rewrite one coherent owner. Remove stale, lower-value, duplicate, narrower, historical, or overlong guidance without losing live behavior. Add only missing behavior that outranks retained guidance. If nothing is removable or no reusable owner is implicated, change nothing.
5. **Verify and stop:** replay the future trigger and run the smallest deterministic checks. Stop when behavior is owned once and touched categories have no unexplained growth.

## Owners

Use the narrowest owner: product code for deterministic behavior; `agent_profile` for role/voice; `user_profile` for stable facts only; `core_doctrine` for cross-domain invariants; one skill for a repeatable workflow; relationship stores for identity; memory-index for provenance/chronology; `short-term-memory/records/` for unfinished continuity.

Discovery metadata owns triggers only; put detail in the owned body, documentation, or schema. Keep product defects out of prompts, procedures out of memory-index, temporary state out of skills, and workflow detail out of core doctrine. Use `skill-creator` for every skill creation, merge, deletion, or trigger change; preserve unique behavior.

## Acceptance

For a changed pass:

- one behavior has one owner; remove obsolete wording and retired owners;
- edited owners are coherent target states, not additive patches;
- retained guidance fits the resident budget; higher-value content replaces or compresses lower-value content before net growth;
- a new skill is one-in-one-out unless no owner can absorb it;
- report before/after bytes and total net delta; explain unavoidable net growth; unexplained growth fails;
- future-trigger replay selects the owner and excludes adjacent non-triggers;
- files parse, links resolve, metadata fits its category, and product changes pass focused tests;
- no source task, secret, or bulky transcript enters durable state.

If unchanged, report the reason, rejected candidates, and inspected owner neighborhood. If changed, report only owner, reduction/addition, size delta, validation, and uncertainty.
