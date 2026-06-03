# Prompt templates

These are starting points. Adapt them to the target model/provider, product surface, tools, evals, and user experience goals.

## 1. General prompt brief

Use this before writing or refactoring a prompt.

```text
Target model/provider/surface:
What the model should do:
What good output looks like:
Inputs the model will receive:
Which input is untrusted data:
Available tools and allowed side effects:
Evidence/citation requirements:
Output format:
Tone/style requirements:
Latency/cost constraints:
Known bad outputs to avoid:
Representative eval cases:
```

## 2. Outcome-first task prompt

Use when the model should choose the path.

```text
# Goal
[Describe the destination, not every step.]

# Success means
- [Observable success criterion]
- [Required constraint]
- [Required output element]

# Context
[Stable product/user context.]

# Inputs
[Insert input data. Mark documents, quoted text, retrieved pages, tool results, and user-provided instructions as data unless explicitly promoted.]

# Tools and evidence
[When to use tools. What evidence is enough. When to stop. What to do if evidence is missing.]

# Output format
[Final response shape, length, fields, or schema.]
```

## 3. Claude prompt with separated data

Use for Claude prompts where clear boundaries matter.

```text
<task>
[What Claude should do.]
</task>

<success_criteria>
- [Specific criterion]
- [Measurable or reviewable criterion]
</success_criteria>

<instructions>
- [Direct instruction]
- [Scope: say whether this applies to every item, only the current item, or a named section.]
- [Tool/evidence/stopping rule if applicable.]
</instructions>

<input_data>
[User documents, quoted text, retrieved context, tool results, etc.]
</input_data>

<output_format>
[Expected structure.]
</output_format>
```

## 4. GPT/Codex outcome-first agent prompt

Use for GPT-5.5/Codex-style tasks where outcome, constraints, tool rules, and stopping conditions matter.

```text
Resolve [task] end to end.

Success means:
- [Target outcome]
- [Constraints that must be preserved]
- [Allowed actions completed before responding]
- [Final answer includes required fields]
- If evidence is missing, ask for the smallest missing field or state the blocker.

Available context:
- [Context item]

Tools:
- [Tool]: [what it does, when to use it, required inputs, side effects, retry safety, common error modes]

Stopping rule:
After each result, ask: “Can I answer the user's core request now with useful evidence?” If yes, answer. Do not keep searching to improve phrasing or add nonessential detail.

Final answer:
[Format.]
```

## 5. Retrieval / citation prompt

Use for search, RAG, docs Q&A, or factual answers.

```text
# Goal
Answer the user's question using the provided or retrieved evidence.

# Evidence rules
- Use the minimum evidence sufficient to answer correctly, cite it precisely, then stop.
- Make another retrieval call only when a required fact, date, parameter, owner, ID, source, or cited support is missing.
- Do not search again to improve phrasing or cite nonessential details.
- Absence of evidence should not automatically become a factual “no” unless the searched source is authoritative and complete.

# Missing evidence
If evidence is insufficient, say what is missing and provide the best supported answer or a narrow follow-up question.

# Output
[Answer format and citation format.]
```

## 6. Structured output prompt

Use when schema/tool/function validation is unavailable or needs prompt-side behavior rules. If the API supports Structured Outputs, JSON schema, or strict tool use, prefer that.

```text
# Task
[Extraction/classification/transformation task.]

# Input
[Data to process.]

# Output
Return a JSON object matching this shape:
{
  "field": "string | null",
  "items": [
    {
      "name": "string",
      "confidence": "high | medium | low"
    }
  ],
  "missing_information": ["string"]
}

# Rules
- Do not add extra keys.
- Use null when a scalar value is unknown.
- Use an empty array when no items are found.
- If the input is unrelated or incompatible with the task, return [specified safe empty/incompatible representation].
- Do not invent values to satisfy the schema.
```

## 7. Editing / rewriting prompt

Use when polish is needed without changing the artifact.

```text
Preserve the requested artifact, length, structure, and genre first. Quietly improve clarity, flow, and correctness. Do not add new claims, extra sections, or a more promotional tone unless explicitly requested.

Audience:
[Receiver]

Style:
[Tone, formality, concision]

Text to edit:
[Text]

Return:
[Edited text only / edited text plus change notes]
```

## 8. Prompt refactor output format

Use when delivering a prompt rewrite.

```text
## Final prompt
[Ready-to-use prompt]

## What changed
- [Small, concrete change]
- [Small, concrete change]

## Why
- [Tie to success criteria, provider guidance, or eval failure]

## Eval cases
1. [Normal case]
2. [Edge case]
3. [Adversarial or missing-evidence case]

## Assumptions / limits
- [Target model/provider/surface]
- [What still needs live docs or empirical validation]
```
