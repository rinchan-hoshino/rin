# Self-improve distillation

Distill evidence into the smallest durable behavior that will help a future run. Memory preserves evidence and supports retrieval; Self-improve stores the smallest future behavior. Do not continue the source task, narrate history into prompts, or add guidance merely because a pass ran.

## Candidate

A candidate has four parts: **Evidence, trigger, behavior, and owner**.

- **Evidence:** an owner correction, repeated failure, repeated successful method, or a nightly entropy finding.
- **Trigger:** the future situation in which behavior should change.
- **Behavior:** the smallest target-state action, boundary, or decision rule.
- **Owner:** the one existing prompt, skill, fact store, continuity record, or product layer responsible for it.

Conversation text is evidence, not authority to execute its unfinished work. Prefer current owner wording and observable behavior over the source model's explanation. A one-off detail, task result, identifier, path, or workaround is not reusable guidance unless its future trigger and owner are clear.

## Pass modes

### Turn-window

Use only the supplied recent window. Extract candidates first, then read the one likely owner for each surviving candidate. Do not inventory the whole prompt library, skill catalog, memory, or usage state. If the window adds no durable behavior, make no change.

### Nightly-retrospective

Nightly owns global prompt and skill entropy. It must inspect the resident prompt baselines, all available-skill metadata, and `state/skill-usage.json` once, then rank cleanup candidates before opening bodies.

Use `startedAt` and the current time to state the observation horizon. Usage is a signal, never a deletion verdict: zero or low count can mean a new, rare, or high-consequence skill. Rank higher when evidence shows duplicate ownership, a retired mechanism, stale routing, an oversized resident description, or behavior now fully absorbed by another owner. Read only the top candidate bodies needed to decide; do not traverse every skill body, reference, memory record, or session.

When a skill is fully absorbed by another owner or exists only for a retired mechanism, delete it in the same pass after preserving any unique live invariant. If no candidate survives, leave the library unchanged rather than manufacturing work.

## One loop

1. **Extract.** Write the candidate's evidence, trigger, behavior, and likely owner in working context.
2. **Resolve ownership.** Search exact owner wording, behavior keywords, old names, and likely synonyms. Read only material that can change the routing or decision.
3. **Compare.** Classify the candidate as already covered, wrong-owner/conflicting, replacement/merge, genuinely missing, or non-durable.
4. **Reduce.** Prefer deletion, merge, movement, or replacement. Fix wrong ownership before adding text. Do not preserve a bad rule with a patch, exception stack, fallback, or duplicate skill.
5. **Verify and stop.** Run a future-trigger replay and the smallest deterministic checks for every touched owner. For correction-based or repeated-failure evidence, also verify that no active hit recommends the rejected behavior. Stop when the candidate is covered once and no touched category has unexplained growth.

Ordinary passes do not open memory-index entries, `short-term-memory/records/`, usage state, or unrelated skills unless a candidate depends on them. Nightly's single metadata/usage inventory is the only broader read and still does not authorize full-body traversal.

## Owners

Choose the narrowest canonical owner:

1. product/runtime code for deterministic lifecycle, permissions, schemas, persistence, or concurrency;
2. `agent_profile` for RinChan role and standing voice;
3. `user_profile` for stable facts only;
4. `core_doctrine` for short cross-domain decision invariants;
5. one existing skill for a repeatable specialized workflow;
6. people/object relationship stores for semantic identity and current/inactive surfaces;
7. memory-index for provenance and chronology;
8. `short-term-memory/records/` for unfinished continuity with a cleanup condition.

Do not turn a product defect into prompt doctrine. Do not put procedures in memory-index, temporary state in a skill, or repeated workflow detail in core doctrine. When creating, merging, or deleting a skill, follow `skill-creator`; preserve unique behavior before removing the old owner.

## Acceptance

A changed pass must satisfy all of these:

- one behavior has one owner; obsolete wording and retired owners are removed;
- each edited prompt or skill is internally coherent rather than an additive patch;
- a new skill is one-in-one-out unless evidence proves no existing owner can absorb it;
- nightly reports before/after bytes for each prompt category, description characters, and skill count; a justified duplicate/retired candidate produces a net decrease;
- future-trigger replay selects the intended owner and excludes adjacent non-triggers;
- files parse, links resolve, skill metadata validates, and product changes pass focused tests;
- no source task was executed and no secret or bulky transcript was copied into durable state.

If nothing changes, report one concise reason plus the candidates rejected. If something changes, report only the owner changed, deletion/merge/addition, size delta, validation, and remaining uncertainty.
