# Prompt review rubric

Use this checklist to review a prompt rewrite before calling it done.

## 1. Success criteria

- The prompt has a clear target outcome.
- The success criteria are specific enough to evaluate.
- The prompt addresses a failure that prompting can actually control.
- Non-prompt blockers are named instead of hidden behind wording.

## 2. Provider and surface fit

- Target model/provider/API/product surface is known or explicitly assumed.
- Provider-specific guidance was checked when exact behavior matters.
- Provider-specific techniques are not applied to another provider as if universal.
- API-supported controls are used where appropriate: structured outputs, tool schemas, reasoning/effort, verbosity, caching, tool descriptions.

## 3. Instruction/data boundary

- Instructions are separated from user data, documents, retrieved content, and tool results.
- Untrusted content cannot override system/developer/tool rules.
- Scope is explicit when an instruction applies to every item, every file, every turn, or every section.
- User-authored content is preserved when the task is editing or refactoring.

## 4. Behavior contract

- The prompt says what good output looks like.
- Required constraints are real invariants, not decorative rules.
- Tool-use triggers are clear when tools exist.
- Evidence and citation requirements are clear when factual grounding matters.
- There is a stopping condition for search, tool loops, or iterative work.
- Missing evidence behavior is defined.
- Side effects and irreversible actions require separate permission.

## 5. Output contract

- Output format matches the receiver and product surface.
- Machine-readable output has schema/tool/function validation when available.
- Unknown, missing, nullable, incompatible, and refusal cases are handled.
- Length, tone, and formatting controls improve comprehension or product fit.

## 6. Examples

- Examples are used when they clarify format, style, edge cases, or classification boundaries.
- Examples are consistent in structure.
- Examples do not introduce unsupported facts, hidden policy changes, or fragile overfitting.

## 7. Evaluation

- There are realistic test cases from the expected use distribution.
- Edge cases and adversarial/prompt-injection cases are included when relevant.
- Objective assertions exist where possible.
- Human review is reserved for genuinely subjective quality.
- The new prompt can be compared with the old prompt or a baseline.

## 8. Entropy check

- Remove repeated, stale, contradictory, or non-operative instructions.
- Keep the smallest prompt that preserves the product contract.
- Positive-instruction check: the prompt describes what the agent should do. It describes what the agent should not do only for strict forbidden zones such as safety, permission, credential/data boundaries, irreversible side effects, or owner-defined hard exclusions.
- Patch-like edit check: no sentence contains a phrase that visibly reads as appended after the fact and can be removed without changing executable behavior. Rewrite the sentence around the owned behavior, evidence, decision rule, or output; remove the phrase when no behavior remains.
- Review behavior rather than keyword absence; a prompt can still be patch-like after every "not" or "avoid" token is removed.
- Add a technique only when it is tied to the goal, provider guidance, or eval result.
- Keep long source quotes, examples, and templates in references rather than bloating the runtime prompt.
