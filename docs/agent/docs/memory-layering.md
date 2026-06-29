# Memory and Self-improve Boundary

Use this document to choose between Rin memory and Rin self-improve surfaces.

Terminology:

- **Memory** is original material plus retrieval: archived transcripts, exact wording, evidence, chronology, provenance, and indexes that help find those originals.
- **Self-improve** is distilled guidance: compact prompt baselines, reusable skills, and short-term continuity records that change future agent behavior.

If an owner correction or repeated failure implies a future behavior change, memory can preserve the evidence, but self-improve carries the executable rule in the prompt or skill surface that future work will use.

Keep these concepts separate even when implementation paths overlap. For example, memory-index files may live under `self_improve/skills` for skill-based discovery, but their job is to point back to memory evidence, not to replace the original evidence.

## Surface model

| Concept      | Surface               | Storage                                                                                | Use when                                                                                                                                    |
| ------------ | --------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory       | Transcript archives   | archived session memory                                                                | Original conversation text, evidence, wording, chronology, or provenance matters                                                            |
| Memory       | Memory index pointers | `self_improve/skills/memory-index/...`                                                 | A compact dated handle helps retrieve original evidence later                                                                               |
| Self-improve | Prompt baselines      | `self_improve/prompts/*.md`                                                            | A compact distilled role, identity fact, or methodology invariant must influence most turns                                                 |
| Self-improve | Reusable skills       | `self_improve/skills/<skill>/`                                                         | A reusable workflow, procedure, playbook, example, owner preference, implicit default, or distilled domain fact should guide matching tasks |
| Self-improve | Short-term continuity | `self_improve/skills/short-term-memory/SKILL.md` plus narrow record files when present | Active distilled handoff state guides current work                                                                                          |

Use the least resident self-improve surface that changes future behavior. Use memory retrieval when original evidence matters.

## Memory surfaces

Memory preserves source material and makes it findable.

Use `recall` when the task depends on:

- past conversations;
- unfinished work;
- original wording;
- evidence or chronology;
- cross-session continuity.

Keep raw event evidence in transcript archives. Add a memory-index pointer only when future lookup needs a stable topic/date/keyword handle.

Use one evolving memory-index transaction for repeated same-topic evidence. Update the monthly index line with date ranges and keywords instead of creating many near-duplicate transaction files.

When a correction proves an operational rule, pair any memory-index pointer with the matching prompt baseline, workflow skill, scheduled-task prompt, or product manual that future work will use, or record why that surface already contains the exact behavior.

## Self-improve surfaces

Self-improve stores distilled guidance the agent should use later.

### Prompt baselines

Prompt baselines are compact rules that should influence most turns.

Active prompt slots:

- `agent_profile`: stable agent role, voice, behavior style, and standing response expectations.
- `user_profile`: stable user identity and compact always-relevant user facts, not preferences.
- `core_doctrine`: durable methodology, values, and decision rules.

Write prompt-baseline lines as dense target behavior. Use one line per topic. Replace superseded lines instead of appending parallel guidance.

Do not store owner preferences in `user_profile`. Store preferences and implicit defaults in the matching skill by default; use `core_doctrine` only when a preference has become a true cross-turn methodology or decision invariant.

### Reusable skills

Skills hold reusable procedural and domain guidance.

Use a skill for:

- operational workflows;
- debugging or validation checklists;
- domain-specific playbooks;
- examples that teach behavior;
- distilled facts, owner preferences, or implicit defaults useful for matching tasks;
- references that would bloat the resident prompt.

Skill descriptions are retrieval handles for distilled guidance. Put detailed instructions in `SKILL.md` or `references/`, not in prompt baselines.

Use composite skills with clear headings for related recurring material. A new skill is useful when it has a distinct recurring trigger and no existing skill is a clean home.

### Short-term continuity

Short-term continuity records contain distilled active state, such as current goal, blocker, handoff state, pending validation, or nearby next action. Keep `short-term-memory/SKILL.md` as a light routing/index entry and store bulky active records in narrow files such as `short-term-memory/records/*.md` when available. Read only the matching record(s) for the current domain; remove or merge records when they stop guiding current work.

## Write-selection flow

When adding or consolidating information, choose the destination in this order:

1. **Memory only:** original wording, evidence, chronology, or provenance is enough; use transcript archives and `recall`.
2. **Memory index pointer:** future lookup needs a compact dated handle to original evidence.
3. **Prompt baseline:** distilled role, owner identity/fact, or methodology invariant must influence most future turns and fits one compact line; `user_profile` does not carry preferences.
4. **Current matching skill:** distilled workflow, domain guidance, owner preference, or implicit default belongs in the active skill. For correction-based reusable behavior, the matching executable surface carries the rule unless it is already present.
5. **Umbrella skill:** a broader existing skill cleanly owns the class of distilled guidance.
6. **Skill reference:** reusable evidence, examples, commands, or traces are useful but too bulky for `SKILL.md`.
7. **New skill:** the distilled trigger is recurring, reusable, and not owned by an existing skill.
8. **Short-term continuity:** distilled state is active temporary handoff context.
9. **No self-improve write:** the material is already covered or does not improve future behavior, routing, execution, or recall.

## Consolidation rules

A self-improve consolidation pass should reduce guidance entropy:

- merge duplicate same-topic guidance into one canonical owner;
- move misplaced content to the surface that owns it;
- replace stale wording with current target behavior;
- delete obsolete aliases, stale short-term records, and narrow fragments without recurring triggers;
- keep ordinary skill `SKILL.md` files as operational entry points, and move bulky evidence to `references/` or active short-term records to narrow record files;
- preserve original evidence through memory archives or memory-index pointers when provenance matters.

Use `docs/self-improve-distillation.md` for the full self-improve distillation workflow.

## Retrieval flow

At task time:

1. Follow prompt baselines for standing posture and constraints.
2. Use the matching skill when its description fits the task.
3. Use `recall` when original context, evidence, wording, chronology, or cross-session continuity matters.
4. Inspect concrete memory or self-improve files only after the retrieval layer points to them.

This keeps distilled guidance compact while preserving original evidence through targeted memory retrieval.
