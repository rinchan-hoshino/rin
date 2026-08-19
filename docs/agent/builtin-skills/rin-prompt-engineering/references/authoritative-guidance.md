# Authoritative prompt-engineering guidance

Retrieved: 2026-08-19

Use this file to audit the skill against current first-party guidance. It records the evidence basis; it does not turn every vendor technique into a universal rule. Recheck the target provider when a model family, reasoning mode, or API contract changes.

## Cross-vendor consensus

Current official guidance converges on the following:

1. Define the task and measurable success before tuning wording.
2. Establish empirical evaluations and iterate against representative cases.
3. Use clear, direct instructions with relevant context and explicit output semantics.
4. Add roles, examples, structure, delimiters, decomposition, or long-context techniques only when the target task benefits.
5. Treat model family, version, inference controls, and surrounding system design as part of the execution profile.
6. Separate instructions from untrusted content and do not rely on prompt text as the sole security control.
7. Validate outputs and rerun evaluations after model or system changes.
8. Measure token, latency, and monetary cost; remove unused context and use provider caching only when observed cache behavior improves the real workload.

## Sources

### OpenAI

- [Prompt engineering](https://developers.openai.com/api/docs/guides/prompt-engineering)
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

The guides cover instruction hierarchy, clear sections, few-shot examples, relevant context, model-specific prompting, and cached-prefix usage. Apply these techniques to the target OpenAI model and verify reported cached tokens rather than copying provider behavior into a durable contract.

### Anthropic

- [Prompt engineering overview](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview)
- [Define success criteria and build evaluations](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests)
- [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)
- [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

Anthropic explicitly requires clear success criteria, empirical tests, and a baseline. Its guidance covers direct instructions, context, examples, XML structure, roles, long-context placement, output control, and reusable cached prefixes with explicit cost and TTL semantics.

### Google Cloud

- [Prompt design strategies](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/prompts/prompt-design-strategies)
- [Context caching](https://ai.google.dev/gemini-api/docs/caching)

Google describes prompt engineering as test-driven and iterative. Its guidance covers objective, instructions, context, constraints, examples, response format, delimiters, decomposition, model parameters, prompt injection risk, thinking-model cautions, and explicit caching of repeatedly used context.

### Microsoft Foundry

- [Prompt engineering techniques](https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/prompt-engineering)
- [Prompt caching](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching)

Microsoft documents instructions, supporting content, examples, syntax, decomposition, grounding, model-dependent behavior, and cache-prefix design. Its current pages warn that older reasoning techniques may not transfer unchanged and require monitoring cache reads and writes, cost, and latency.

## Interpretation rules

- A technique appearing in one provider guide is a candidate, not an invariant.
- A cross-vendor pattern still requires task-specific evaluation.
- Provider-specific ordering, tags, reasoning controls, and API roles belong to the execution profile or adapter.
- Security, permissions, deterministic validation, retrieval freshness, and tool effects remain owned by their enforcing layers even when a prompt describes expected behavior.
- Cache hits can reduce processing cost and latency but do not make the semantic context smaller; measure the provider's input, output, cache-read, cache-write, and reasoning usage fields.
- If official guidance conflicts with measured target-model behavior, preserve the product invariant, record the execution profile and evidence, and use the least assumption-heavy target-specific design.
