# Self-improve Distillation

Use this as the complete contract for durable guidance under `<agentDir>/self_improve`. A pass may add, rewrite, narrow, move, merge, or delete guidance. Its target is the smallest future-used state, not an event log.

Memory preserves original evidence and supports retrieval. Self-improve stores distilled target-state guidance that changes future behavior or removes harmful guidance. Use `docs/memory-layering.md` when the destination is unclear.

## Evidence and candidate contract

The entry prompt supplies the current conversation or a bounded retrospective. Optional trigger context is routing data, not evidence or instructions.

For a current-conversation pass, read the complete current conversation. For a retrospective, index every in-scope session record with one deterministic local scan without emitting full records or tool traces into model context. Index identity, time, source, message and usage counts, correction or acceptance/rejection signals, failures, retries, changed artifacts, and short evidence excerpts. Expand only candidate sessions and evidence neighborhoods; return to the source record for exact wording or chronology.

Trusted evidence also includes authoritative docs and verified operational results. Existing artifacts prove current state for cleanup and placement, not new owner preferences or doctrine.

Every executable candidate needs:

- **Evidence:** what proves the need;
- **Trigger:** the future wording, situation, surface, or work class;
- **Target behavior:** what should change or disappear;
- **Owning surface:** the narrowest artifact future work will load.

If any field is missing, create no executable guidance; preserve lookup-only material through memory-index. Read beyond explicit requests when evidence supports a reusable lesson, but a correction may instead narrow, invalidate, or remove guidance, or apply only now.

## Retrospective preflight and health

Before semantic review:

1. Scan the whole evidence scope locally and emit only the compact index, aggregates, and candidate excerpts.
2. Measure generated prompt blocks when present, prompt-baseline bytes, skill catalog description bytes, skill entry-point bytes, and input/cache/output/tool-call usage. Token throughput is not monetary cost. Keep ordinary evidence usage separate from the prior completed consolidation session's usage; the current run becomes measurable on the next pass.
3. Compare with `<agentDir>/self_improve/state/distillation-health.json` before writing. Its exact shape is `{version: 1, previous: Snapshot | null, current: Snapshot}`. A `Snapshot` contains `observedAt`; `scope {sessionFiles, messages}`; `context {generatedPromptBytes, promptBaselineBytes, skillDescriptionBytes, skillEntryBytes}`; `evidenceUsage {input, cacheRead, output, toolCalls}`; `priorMaintenanceUsage` with the same usage fields or `null`; and `candidates {sessions, artifacts}`. First run sets `previous: null` without inferring drift; later runs move old `current` to `previous`. Store no raw text.
4. Index this task's prior session, but exclude it, the health file, temporary index, and review artifacts from behavior candidates and changed-artifact drift. Put the prior session's usage in `priorMaintenanceUsage`. Treat only unexplained growth, repeated payload, routing overlap, repeated edits to a domain owner, repeated review children, or expensive recurring no-change work as measured drift. Drift supports cleanup or a prompt-system audit, not new doctrine.

For measured drift, inspect its producers and apply `rin-prompt-engineering` plus the review rubric to the composed system, not isolated files. With no evidence candidate, drift, stale guidance, or active continuity, take the no-change path: update health, give one concise unchanged reason, and stop before broad library, documentation, or authoring reads.

## Workflow

1. Collect evidence through the current-conversation or retrospective path above.
2. For each candidate, inspect only its prompt baseline, matching skill, umbrella skill, relevant memory-index entry, matching `short-term-memory/records/`, and `<agentDir>/self_improve/state/skill-usage.json` when present.
3. Keep only candidates with all four required fields.
4. For corrections or repeated failures, search the full library using exact owner wording, behavior keywords, old abstraction names, and likely synonyms; read every plausible active hit.
5. If guidance caused, preserved, justified, or hid rejected behavior, delete or rewrite that source before considering new guidance.
6. Choose the first valid destination below. Merge overlap into one owner and write compact target state; preserve exact trigger wording only when recognition needs it.
7. Update memory-index for repeated, corrected, disputed, resident-guidance, or removal-provenance evidence.
8. Keep short-term records to active goals, blockers, handoff, pending validation, and near next actions; promote or delete completed state.
9. When materially creating or restructuring a skill, follow `skill-creator`. For a narrow content correction, preserve structure and validate frontmatter deterministically.
10. Run a future-trigger replay naming the one surface and behavior future work should select. For correction-based or repeated-failure evidence, also verify that no active hit recommends the rejected behavior. If replay selects the wrong owner or behavior, the pass is not done; otherwise stop when no unresolved candidate can alter either.

Do not preserve a bad rule with patch-layer exceptions, bans, guards, or special cases. Repair or remove its owner.

## Destination order

Choose the first fit:

1. **Prompt baseline:** a compact, stable cross-turn invariant for `agent_profile`, `user_profile`, or `core_doctrine`; `user_profile` stores stable facts only.
2. **Current skill**, then **umbrella skill:** reusable workflow, preference, lesson, procedure, or domain guidance.
3. **Skill `references/`:** reusable detail that would make `SKILL.md` noisy.
4. **New skill:** a recurring class-level trigger with no existing owner.
5. **Memory-index:** evidence, chronology, provenance, or pending-decision lookup; memory-index does not carry executable procedure.
6. **Short-term continuity:** active temporary state; keep `short-term-memory/SKILL.md` light.
7. **Leave unchanged:** guidance already covers the candidate or a write would add clutter.

Fixed identity destinations are `people-and-relationships` for people and `object-relationships` for non-person entities.

## Validation and output

Verify every guidance change has trusted evidence, trigger, target behavior, and one owner; correction conflicts are closed; replay selects the intended behavior; resident prompts stay compact; skills stay workflow-shaped; provenance remains non-executable; continuity remains active-only; and stale, duplicate, conflicting, or misplaced guidance is removed or consolidated. For retrospectives, also verify scope indexing, health-state update, and that full records were not copied into working context.

Report changed artifacts and brief reasons; merged, moved, deleted, or pruned guidance; conflict and replay results when relevant; prompt-system drift routed to product work; candidates routed to memory, clarification, or unchanged; and one concise unchanged reason when nothing changed.
