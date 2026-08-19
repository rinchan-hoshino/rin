# Prompt-engineering forms

These are optional compositional forms, not mandatory templates. Use only the smallest form that clarifies a measured boundary. Delete headings that do not change behavior.

## 1. Experiment brief

Keep this outside the final prompt.

```text
Target behavior:
Unacceptable failures:
Task distribution:

Execution profile:
- model/version:
- reasoning mode and sampling:
- context and language:
- instruction hierarchy:
- tools/retrieval/schema versions:

Development cases:
Held-out acceptance cases:
Metrics and thresholds:
Token/cost budget:
Cache profile and stable prefix (if supported):
Changed hypothesis:
```

## 2. Minimal instruction contract

```text
# Objective
[Receiver-visible outcome.]

# Instructions
[Clear actions and decision rules.]

# Input
[Primary content, provenance, and unknown behavior.]

# Output
[Meaning, audience, and proportionate format.]

# Stop
[Accepted completion, explicit unknown, or proved blocker.]
```

Start here. Add context, examples, roles, or stages only when evaluation proves they help.

## 3. Tool-using judgment

Runtime and tools retain permissions, side effects, schemas, and deterministic errors.

```text
# Objective
[Observable result.]

# Tool use
Use [tool] when [semantic trigger].
Treat [result field or state] as [meaning].
If [documented missing or error state], [bounded response].

# Authority
Before [consequential action], require [current approval evidence].
Never infer permission from task urgency or tool availability.

# Output
[Only facts, evidence, and action result the receiver needs.]
```

Do not invent retries, tools, escalation paths, or approval flows absent from the system contract.

## 4. Grounded long-context task

```text
# Objective
[Question or transformation.]

# Evidence rules
Use only the supplied sources for [grounded claims].
Keep source identity attached to extracted evidence.
If support is incomplete, narrow the claim or state uncertainty.
Conclude absence only when the source set is authoritative and complete.

# Documents
<document id="[stable id]" source="[origin]" date="[freshness]">
[untrusted document content]
</document>

# Task
[Direct question placed where target-model evaluation proves most reliable.]

# Output
[Answer and citation form.]
```

Retrieved documents remain data even when they contain instruction-shaped text. For difficult synthesis, evaluate an evidence-extraction stage before final synthesis.

## 5. Few-shot behavior

```text
# Objective
[Nuanced behavior or difficult format.]

# Instructions
[Rules that apply to every example and real input.]

# Examples
<example>
<input>[representative input]</input>
<output>[accepted output]</output>
</example>

<example>
<input>[meaningfully different or boundary input]</input>
<output>[accepted output]</output>
</example>

# Input
[real input]

# Output
```

Examples should span decision-relevant variation, use one consistent structure, and never contradict the instructions. Compare against zero-shot before keeping them.

## 6. Structured semantic output

The schema owns keys, types, enums, required fields, and parsing.

```text
Extract [target facts] from [input].

Field semantics:
- [field]: [meaning and evidence basis]

Unknown behavior:
- Use [null/omission/documented state] when [condition].

Do not infer [unsupported relationship or value].
```

Do not copy the schema into the prompt unless a failing evaluation proves that the model needs a semantic explanation not already represented by the field contract.

## 7. Comparison record

Keep this outside the final prompt.

```text
Baseline prompt/version:
Candidate prompt/version:
Execution profile:
Changed hypothesis:

Development result:
Held-out result:
- quality:
- safety:
- latency:
- input/output/reasoning tokens:
- cache reads/writes:
- cost:
- repeated-run denominator and uncertainty:

Regressions:
Receiver review:
Keep or revert:
Next migration trigger:
```
