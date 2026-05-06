# Self-improve memory maintenance manual

## Basic concepts

### Self improve prompts

- Self improve prompts are always-on baselines loaded into future turns. Location: `<agentDir>/self_improve/prompts`.
- Self improve prompts have these three active slots:
  - `agent_profile` stores agent role information and language style; limit 8 lines.
  - `user_profile` stores basic user information; limit 4 lines.
  - `core_doctrine` stores durable methodology, worldview, and values; limit 32 lines.

### Self improve skills

- Self improve skills are reusable skill documents loaded only when relevant. Location: `<agentDir>/self_improve/skills`.
- Self improve skills follow the agent standard Skills specification.
- Self improve skills include several fixed types:
  - Memory-index skills: record key events and their original memory files for quick indexing.
  - Temporary task notes: record very short-term memories for quick recall.

## Document writing rules

- Always follow the prompt-engineer skill guidance.
- Prefer target-state wording over historical explanations.
- Prefer direct behavior and concrete examples over abstract labels.
- Prompt baselines: prompt slot content is a full revised canonical replacement, not an append-only patch. Rewrite the slot into its best current compact form by revising, polishing, compressing, merging, moving, or deleting existing lines as needed. Use one concise, information-dense line per topic. Keep only durable behavior needed in almost every turn, and respect the current slot limits.
- Skills: when one topic needs steps, branching logic, examples, references, domain facts, operating knowledge, or several related lines, put it in a skill. Follow the skill-creator skill guidance when creating or updating skills. Prefer updating an existing relevant skill over creating a new one. Create a new skill only when the trigger is reusable and no existing skill is a good home. Use composite skills with headings and bundled references instead of one skill per fact. Skills are indexed into the system prompt, so control their count; use layered indexes to keep outer entries compact when needed. Also:
  - Memory-index skills: for key events, record the date, keywords, topic/person/project, why it matters, and original memory file in an index document, but do not copy long raw excerpts.
  - Temporary task notes: record very short-term events when useful for preserving impressions; clean them frequently so they stay fresh.

## Distillation steps

1. Inspect existing prompt baselines and relevant skills before writing. For prompt baseline updates, read the current slot first. Read enough existing material to avoid duplicates and choose the right destination.
2. Extract as many candidate memories as possible from the available evidence, then discard low-signal details early to keep the attention budget high.
3. Score each candidate on three 0-3 dimensions: attention (centrality to the task), emotion (correction, risk, preference, or blocker strength), and repetition (confirmed or repeated in current evidence or existing memory).
4. Link each candidate to old knowledge: update an existing prompt line, skill, or index; supersede stale material; or discard it.
5. Choose a destination using the rules below. If a candidate fits multiple destinations, choose the least resident option that still preserves future behavior.
6. Edit by merging, compressing, correcting, moving, or deleting material. Delete only when a point is clearly obsolete, duplicated after merge, or contradicted by newer accepted guidance.

## Destination rules

- Prompt baseline: use when the content affects almost every future response and cannot be better handled by a skill. Require emotion 2+ or repetition 2+.
- Skill: use for reusable procedures, workflows, checklists, playbooks, references, durable knowledge, examples, indexes, and operating knowledge. Require attention 2+, emotion 2+, or repetition 2+.
- Memory-index skill: use when future lookup by time, keyword, person, project, failure, or decision may need exact event evidence. Prefer updating a composite index skill.
- Temporary task note: use only for active, very short-term state.
- No durable write: use when all scores are low, the item is one-off, or the original memory already covers it well enough.

## Final output format

- List changed files and one short reason per file.
- If nothing changed, say why.
- List skipped or risky items that need owner confirmation or fresher evidence.
