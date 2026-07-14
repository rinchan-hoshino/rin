# Prompt review rubric

Review the prompt as an executable behavior contract. Mark each item pass, fail, not applicable, or unverified.

## 1. Function and acceptance

- The target behavior is stated from the receiver's perspective.
- Success is observable through an output, state, assertion, or feedback signal.
- Unacceptable failures and real invariants are explicit.
- The prompt is the correct layer for the behavior it controls.
- Missing data, broken tools, runtime defects, and weak validation are not hidden with wording.

## 2. Context and ownership

- Each behavior has one semantic owner.
- Stable instructions, task input, retrieved context, tool contracts, and validation rules live in the appropriate layer.
- Context is relevant, current, and no larger than needed.
- Large or changing context is retrieved progressively when possible.
- Duplicated, stale, conflicting, and non-operative context is removed.
- The durable prompt contains no compatibility patches for a named vendor, model family, version, or transient quirk.

## 3. Authority and input trust

- Runtime instruction priority is respected.
- Documents, quotes, retrieved pages, tool results, and embedded instruction-like fields are classified as data unless explicitly promoted.
- User-authored content is preserved when surrounding metadata or instructions are edited.
- Allowed actions and side effects match the task's authority.
- External, destructive, costly, security-sensitive, and scope-expanding actions have an approval boundary.

## 4. Behavior design

- The prompt leads with the outcome and accepted result.
- Process steps appear only when order, completeness, auditability, or safety requires them.
- Degree of freedom matches task variability and risk.
- Instructions describe the behavior to perform.
- Prohibitions protect real forbidden zones rather than patching ordinary judgment.
- Absolute words are reserved for invariants; judgment uses decision rules.
- Rationale appears only when it improves correct generalization.
- Every sentence changes a trigger, action, source, decision, output, approval boundary, or stop condition.

## 5. Structure and examples

- Instructions, context, examples, and input data are distinguishable.
- Structure reduces ambiguity without adding ceremony.
- Examples clarify a measured boundary, format, classification, or style.
- Examples are realistic, varied, consistently structured, and free of accidental rules.
- Examples that do not improve behavior are removed.

## 6. Tools, evidence, and completion

- Tool triggers, prerequisites, important results, and error behavior are clear.
- Tool-specific semantics live in the tool contract when possible.
- Independent reads may run together; dependent actions remain sequential.
- Evidence sufficiency and citation behavior are explicit when claims require grounding.
- Retry and fallback limits are bounded.
- Side effects are verified from the target surface before success is reported.
- Missing, ambiguous, incompatible, unsafe, and unsupported input have defined behavior.
- Search, iteration, and tool loops have stopping conditions.

## 7. Output and deterministic enforcement

- Output matches its human or machine receiver.
- Required facts, fields, length, and structure are clear.
- Unknown, empty, null, false, incompatible, and refusal states remain distinguishable.
- Schemas, typed tools, validators, permissions, and program logic enforce deterministic constraints where available.
- The prompt defines semantic behavior rather than imitating a parser or validator.

## 8. Evaluation

- A baseline prompt and output set exist when improving an artifact.
- Eval cases represent the expected task distribution.
- Normal, boundary, missing-input, conflicting-instruction, and adversarial cases are included where relevant.
- Assertions test behavior and side effects rather than incidental wording.
- Subjective quality uses a receiver rubric or pairwise comparison.
- Variable high-risk cases are repeated enough to expose instability.
- Each material change states a hypothesis and keep-or-revert signal.
- Comparable evidence shows improvement without invariant regressions.

## 9. Final entropy check

- The final artifact is a canonical target state, not a list of patches.
- No stale workaround survives beside its replacement.
- No rule is repeated to simulate priority.
- No section exists only because a template offered it.
- The prompt is the smallest coherent contract that meets acceptance.
