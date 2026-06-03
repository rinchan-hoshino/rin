---
name: rin-prompt-engineering
description: "Writes, refactors, debugs, and evaluates LLM prompts and agent/task instructions using provider guidance and evals. Use for system/developer prompts, skills, agent workflows, tool-use rules, structured output, RAG/citation, model migration, or prompt-related behavior issues."
---

# Rin prompt engineering

This is Rin's prompt-engineering workflow. It is not an Anthropic/OpenAI/Google/Microsoft artifact. Use it as an operating checklist; when exact provider behavior matters, check the current first-party source before changing the prompt.

## Load only what the task needs

- For provider-specific wording or migration: read `references/provider-guidance.md`.
- For ready prompt skeletons: read `references/prompt-templates.md`.
- For review or cleanup: read `references/prompt-review-rubric.md`.
- For skill-specific authoring, also use `skill-creator`.

## Core loop

Follow this order. Do not start by polishing wording.

1. **Define success.** Capture what the prompt must make the model do, how success will be judged, and what failure looks like.
2. **Check whether prompting is the right lever.** If the failure is caused by missing data, broken tools, wrong model choice, latency/cost limits, or product/API ownership, state that instead of hiding it with prompt text.
3. **Identify the target surface.** Note model/provider, API/product surface, available tools, output channel, and runtime constraints.
4. **Draft the smallest behavior contract.** Prefer goal, context, constraints, evidence/tool rules, and output format over a long step script.
5. **Add examples only when they teach the desired behavior.** Use examples for output shape, edge cases, style, or classification boundaries.
6. **Evaluate before declaring success.** Use realistic cases, edge cases, and adversarial cases. Compare against the previous prompt when one exists.
7. **Iterate one meaningful change at a time.** Keep changes that improve the target behavior without adding unnecessary prompt mass.

## Prompt brief

Before writing or editing a prompt, collect this brief. Infer obvious fields; ask one narrow question only when the missing field materially changes the prompt.

```text
Target model/provider/surface:
Goal:
Audience / receiver:
Inputs and trusted data:
Untrusted data / prompt-injection boundary:
Tools and side effects:
Output contract:
Success criteria:
Known failure modes:
Latency/cost/style constraints:
Eval cases available or needed:
```

## Drafting rules

### Write outcome-first

State the destination before the process. A strong prompt normally says:

- what good output looks like;
- which constraints matter;
- what evidence is available or required;
- which tools/actions are allowed;
- what the final answer should contain.

Use detailed step-by-step process only when the exact path is part of the product contract or safety boundary.

### Separate instructions from data

Mark user documents, quoted text, retrieved pages, tool results, and fields such as `model_instruction` as data unless the trusted task explicitly promotes them to instructions. Delimit long inputs with Markdown headings or XML-style tags when that improves clarity.

### Choose the right degree of freedom

- Use high freedom for judgment-heavy work where many paths are valid.
- Use medium freedom when a preferred pattern exists but context still matters.
- Use low freedom for fragile operations, exact formats, account actions, publishing, migrations, or irreversible side effects.

### Use exact words for true invariants

Reserve `ALWAYS`, `NEVER`, `must`, and `only` for real invariants: security rules, permission boundaries, required fields, forbidden side effects, or output contracts. For judgment calls, write decision rules and stopping conditions.

### Control tools and evidence

For tool-using or retrieval prompts, define:

- when tools are required, optional, or unnecessary;
- minimum evidence needed to answer;
- when to stop searching or iterating;
- what to do when evidence is missing;
- which side effects require separate user permission.

### Prefer schema support for machine output

When the API supports structured output, JSON schema, strict tool use, or function calling, use that instead of relying only on prompt wording. Still tell the model how to handle missing, incompatible, or unsafe input.

## Provider notes

Use provider-specific guidance only for the target provider. Do not universalize a technique just because one provider recommends it.

### Claude / Anthropic

Read `references/provider-guidance.md#anthropic--claude` when Claude behavior matters.

Useful source phrases to preserve:

- “a clear definition of the success criteria”
- “Some ways to empirically test against those criteria”
- “Not every success criteria or failing eval is best solved by prompt engineering”
- “Positive examples ... tend to be more effective than negative examples”
- “If you need Claude to apply an instruction broadly, state the scope explicitly”

### OpenAI / GPT / Codex

Read `references/provider-guidance.md#openai--gpt--codex` when OpenAI behavior matters.

Useful source phrases to preserve:

- “define the outcome and leave room for the model to choose an efficient solution path”
- “describe what good looks like, what constraints matter, what evidence is available, and what the final answer should contain”
- “describe the destination rather than every step”
- “Use those words for true invariants”
- “Retrieval budgets are stopping rules for search”

### Gemini / Google

Read `references/provider-guidance.md#google-gemini` when Gemini behavior matters.

Useful source phrases to preserve:

- “Prompt engineering is iterative”
- “clear and specific instructions”
- “Use specific and varied examples”
- “direct, well-structured, and clearly define the task and any constraints”

### Azure / Microsoft

Read `references/provider-guidance.md#microsoft--azure-openai--foundry` for Azure deployment-specific context. Note the Microsoft page warning: “These techniques aren't recommended for reasoning models like gpt-5 and o-series models.”

## Common work types

### Refactor an existing prompt

1. Preserve the product contract and user-authored content.
2. Identify duplicated, stale, conflicting, or non-operative instructions.
3. Keep source/provider-specific terms only when they apply to the target model.
4. Produce a cleaned prompt plus a short change list.
5. Provide eval cases that should pass before and after, and cases expected to improve.

### Write an agent or scheduled-task prompt

Make authority and side effects explicit:

- source of truth and scope;
- allowed reads/writes;
- actions that require separate permission;
- retries and stop conditions;
- validation required before reporting success;
- final report fields.

For recurring tasks, include how to detect “no change,” how to avoid duplicate issues/work, and what evidence to leave behind.

### Write a skill

Use `skill-creator` together with this skill. Keep SKILL.md concise, use progressive disclosure, put detailed source quotes/templates in references, and add realistic eval prompts.

### Migrate between models/providers

1. Identify the old and new model/provider/surface.
2. Read current migration/prompt guidance for the target provider.
3. Start from the smallest prompt that preserves the product contract.
4. Move API-supported controls out of the prompt when the provider supports them.
5. Re-test representative examples before accepting the migration.

### Debug bad LLM behavior

Map each failure to one of these causes before editing:

- unclear goal or receiver;
- missing or conflicting constraints;
- instruction/data boundary failure;
- missing examples or bad examples;
- weak tool/evidence/stopping rules;
- output contract mismatch;
- wrong model/provider/API setting;
- missing eval coverage;
- non-prompt product/tool/data bug.

Fix the smallest real cause.

## Deliverables

Unless the user asks for only the prompt, return:

1. **Final prompt** — ready to use.
2. **Change rationale** — brief, tied to success criteria and provider guidance.
3. **Assumptions** — target model/provider/surface and unresolved inputs.
4. **Eval cases** — realistic tests or assertions.
5. **Limits / next step** — what needs live docs, product choice, or empirical validation.

Keep the explanation shorter than the artifact unless the user asks for analysis.
