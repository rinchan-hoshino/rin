# Prompt-engineering review

Use this for debugging, comparing, migrating, or accepting an LLM-facing instruction. Review the prompt and the system that executes it. Mark each decision `pass`, `fail`, or `unproved`, with one piece of evidence.

## 1. Readiness and success

- The receiver-visible objective, unacceptable failures, and measurable success criteria are explicit.
- The current prompt and representative behavior are preserved as a baseline.
- The target model can perform the task with the available context, tools, and authority.
- The task distribution, operational constraints, and owner decisions are known.
- Missing product design is an explicit unknown or decision-changing question, not an invitation to invent behavior.

Stop when these are absent. More wording cannot repair an undefined target, invalid metric, incapable model, or missing system capability.

## 2. Execution profile and system ownership

- Target model/version, reasoning mode, sampling parameters, language, context limits, instruction hierarchy, and tool/schema versions are recorded.
- Prompt engineering is the correct lever; model selection, retrieval, tools, workflow, schemas, runtime enforcement, or fine-tuning would not own the failure better.
- Prompt, runtime, tools, retrieval, schema, input data, and evaluations each have one enforceable responsibility.
- Trusted instructions are distinct from user-authored or externally retrieved data.
- Stable product policy is separate from model-specific tuning.

Fail when prompt text pretends to grant permission, refresh data, validate deterministic shape, create lifecycle state, or reconcile competing semantic owners.

## 3. Instruction design

- The objective and direct instructions precede unnecessary implementation detail.
- Terms, limits, unknown states, output semantics, and stop conditions are unambiguous.
- Every capability, role, state, retry, exception, and example has an accepted source.
- Context includes only task-relevant information and preserves provenance and freshness where needed.
- Instructions, context, examples, documents, and tool output use enough structure to remain distinguishable.
- Positive desired behavior is preferred; prohibitions protect actual safety, authority, privacy, or integrity boundaries.
- Roles contribute expertise, audience, or tone rather than decoration.
- Few-shot examples are used only when they improve evaluations; they are relevant, diverse, consistently formatted, and instruction-compatible.
- Long-context prompts mark document boundaries and support evidence-grounded synthesis.
- Machine-readable output relies on an enforcing schema; the prompt defines only semantics and unknown behavior.
- Task decomposition improves correctness, observability, or tool use rather than eliciting hidden reasoning.
- No instruction requests or exposes hidden chain-of-thought.

Compare nearby candidates that meet the same criteria. Prefer the one with fewer assumptions. The accepted prompt should read as one coherent artifact, not a history of incidents or patches.

## 4. Security and authority

- Direct and indirect prompt injection are represented in the threat model and tests.
- Untrusted documents, files, web content, tool results, and quoted prompts cannot become trusted instructions by formatting alone.
- Evaluations cover exfiltration, secret requests, cross-user leakage, tool misuse, and approval bypass where relevant.
- Least privilege, allowlists, argument validation, output validation, secret isolation, and consequential-action confirmation are enforced outside the prompt.
- Human approval or runtime containment exists when a model mistake can cause material harm.
- Prompt wording is not claimed as the security boundary.

## 5. Evaluation design

- A development set supports iteration and a separate held-out set owns acceptance.
- Cases reflect the real task distribution and include normal, boundary, missing-input, adversarial, authority, and historical-failure cases.
- Metrics are task-specific and measurable; quality, safety, latency, and cost are included when decision-relevant.
- Input, output, cached, cache-write, and reasoning tokens are measured separately when available; loaded skill/reference context is included.
- Stable and dynamic content placement follows measured provider cache semantics, not a generic caching claim.
- Baseline and candidate use the same execution profile.
- Assertions observe semantic output, citations, tool calls, side effects, or forbidden actions—not incidental phrasing.
- Subjective quality uses blind or pairwise receiver review after correctness passes.
- Variable and high-risk cases are repeated enough to expose instability; results include denominators and material uncertainty.
- One causal hypothesis changes at a time, and keep-or-revert follows the declared criteria.
- The held-out suite is rerun after model, reasoning, hierarchy, tool, retrieval, schema, or material-context changes.

Fail an evaluation that rewards verbosity, unsupported completeness, consumer-side repair, or behavior outside the product target.

## 6. Lifecycle and final cleanliness

Accept only when all are true:

- prompt and evaluation versions identify the tested execution profile;
- one canonical prompt replaces superseded wording;
- no stale workaround, duplicate priority, unsupported capability, or parallel owner remains;
- diagnostic scaffolding and model quirks that no longer apply are removed;
- no token saving merely shifts cost into longer output, repeated tool calls, or lost cache hits;
- the final artifact is proportionate, stays within its accepted token budget, and every section earns its place;
- the owner-facing report states observed evidence and uncertainty rather than retroactively justifying the design.
