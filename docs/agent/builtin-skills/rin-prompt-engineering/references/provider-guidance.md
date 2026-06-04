# Provider guidance for prompt work

This file records first-party source URLs and short verified excerpts. Use exact source wording when it cleanly fits the prompt or review note. Do not present this Rin skill as provider-authored.

## Skill authoring sources

### Anthropic Agent Skills

- Skill authoring best practices: `https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices.md`
- Agent Skills overview: `https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview.md`
- Rin-installed authoritative skill-creator: `/home/rin/.rin/docs/rin/builtin-skills/skill-creator/SKILL.md`

Verified excerpts:

> “Good Skills are concise, well-structured, and tested with real usage.”

> “Concise is key”

> “Default assumption: Claude is already very smart”

> “Only add context Claude doesn't already have.”

> “Set appropriate degrees of freedom”

> “The `description` field enables Skill discovery and should include both what the Skill does and when to use it.”

> “Always write in third person”

> “Progressive disclosure ensures only relevant content occupies the context window at any given time.”

> “Skills are reusable, filesystem-based resources that provide Claude with domain-specific expertise: workflows, context, and best practices that transform general-purpose agents into specialists.”

Use in Rin prompt work:

- Keep `SKILL.md` as the concise operational entry point.
- Put long source excerpts, templates, and examples in `references/`.
- Add eval prompts for reusable skills.
- Tune the frontmatter `description` for discovery; put “what it does” and “when to use it” there.

## Anthropic / Claude

### Prompt engineering overview

Source: `https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview.md`

Verified excerpts:

> “This guide assumes that you have: 1. A clear definition of the success criteria for your use case 2. Some ways to empirically test against those criteria 3. A first draft prompt you want to improve”

> “Not every success criteria or failing eval is best solved by prompt engineering.”

> “All prompting techniques — from clarity and examples to XML structuring, role prompting, thinking, and prompt chaining — are covered in Prompting best practices. That's the living reference; start there.”

Use in Rin prompt work:

- Start prompt refactors with success criteria, eval method, and baseline prompt.
- If the failure is not controllable through prompting, say so.
- For Claude-specific behavior, read the current best-practices page before making exact claims.

### Prompting best practices

Source: `https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices.md`

Verified excerpts:

> “This is the single reference for prompt engineering with Claude's latest models”

> “Positive examples showing how Claude can communicate with the appropriate level of concision tend to be more effective than negative examples or instructions that tell the model what not to do.”

> “If you observe shallow reasoning on complex problems, raise effort to `high` or `xhigh` rather than prompting around it.”

> “For scenarios where you want more tool use, you can also adjust your prompt to explicitly instruct the model about when and how to properly use its tools.”

> “If you need Claude to apply an instruction broadly, state the scope explicitly”

> “If your product relies on a specific voice, re-evaluate style prompts against the new baseline.”

Use in Rin prompt work:

- Prefer positive examples for style, concision, and output quality.
- Treat effort/model parameters as part of the prompt-design surface when available.
- State instruction scope explicitly when it must apply across every item, section, file, turn, or tool.
- Define tool-use triggers instead of assuming the model will infer them.

### Anthropic evals

Source: `https://platform.claude.com/docs/en/test-and-evaluate/develop-tests.md`

Verified excerpts:

> “Building a successful LLM-based application starts with clearly defining your success criteria and then designing evaluations to measure performance against them.”

> “Good success criteria are:”

> “Specific”

> “Measurable”

> “Achievable”

> “Relevant”

> “Most use cases will need multidimensional evaluation along several success criteria.”

> “Be task-specific: Design evals that mirror your real-world task distribution. Don't forget to factor in edge cases!”

> “Automate when possible”

> “Prioritize volume over quality”

Use in Rin prompt work:

- Write eval cases that mirror real use, not only clean examples.
- Include edge cases and prompt-injection attempts when the prompt handles external content.
- Use objective assertions where possible; keep human review for subjective style/product quality.

### Anthropic interactive tutorial

Source: `https://github.com/anthropics/prompt-eng-interactive-tutorial`

Useful chapter labels:

- “Basic Prompt Structure”
- “Being Clear and Direct”
- “Assigning Roles”
- “Separating Data from Instructions”
- “Formatting Output & Speaking for Claude”
- “Thinking Step by Step”
- “Using Examples”
- “Avoiding Hallucinations”
- “Building Complex Prompts”
- “Chaining Prompts”
- “Tool Use”
- “Search & Retrieval”

Use these as categories to check, not mandatory techniques to include every time.

## OpenAI / GPT / Codex

### GPT-5.5 prompting guide

Source: `https://developers.openai.com/api/docs/guides/prompt-guidance`

Verified excerpts:

> “GPT-5.5 works best when prompts define the outcome and leave room for the model to choose an efficient solution path.”

> “describe what good looks like, what constraints matter, what evidence is available, and what the final answer should contain.”

> “The patterns here are starting points. Adapt them to your product surface, tools, evals, and user experience goals.”

> “Personality controls how the assistant sounds”

> “Collaboration style controls how the assistant works”

> “Use personality to shape the experience, not to compensate for unclear goals or missing task instructions.”

> “For many tasks, describe the destination rather than every step.”

> “Use those words for true invariants, such as safety rules, required output fields, or actions that should never happen.”

> “Retrieval budgets are stopping rules for search. They tell the model when enough evidence is enough.”

> “Absence of evidence shouldn’t automatically become a factual ‘no.’”

> “Preserve the requested artifact, length, structure, and genre first.”

Use in Rin prompt work:

- Use outcome-first prompts for GPT/Codex unless the product requires the exact path.
- Keep personality short and separate from collaboration behavior.
- Add retrieval budgets to search/RAG prompts.
- For editing prompts, say what must be preserved before asking for polish.

### GPT-5.5 latest model guide

Source: `https://developers.openai.com/api/docs/guides/latest-model`

Verified excerpts:

> “Begin migration with a fresh baseline instead of carrying over every instruction from an older prompt stack.”

> “Start with the smallest prompt that preserves the product contract”

> “State the expected outcome and success criteria.”

> “Let GPT-5.5 choose the path unless the product requires that path.”

> “Put most tool-specific guidance in the tool descriptions themselves: what the tool does, when to use it, required inputs, side effects, retry safety, and common error modes.”

> “Drop the current date. The model is already aware of the current UTC date.”

> “Codex can apply the recommended changes in this guide with the OpenAI Docs Skill”

Use in Rin prompt work:

- For GPT-5.5 migrations, reduce the prompt stack first, then add only measured controls.
- Move tool-specific behavior into tool descriptions when the platform supports it.
- Treat current-date removal as model-specific GPT-5.5 migration advice; preserve Rin's runtime date unless the target prompt surface and evals show it is unnecessary.

### OpenAI Docs Skill candidate

Source: `https://github.com/openai/skills/tree/main/skills/.curated/openai-docs`

Verified excerpts:

> “This skill also owns model selection, API model migration, and prompt-upgrade guidance.”

> “For model-selection, "latest model", or default-model questions, fetch `https://developers.openai.com/api/docs/guides/latest-model.md` first.”

Use in Rin prompt work:

- Treat `openai-docs` as first-party OpenAI-specific prompt-upgrade guidance, not as a provider-neutral prompt-engineer replacement.
- Do not mirror or install it in place of Rin's own prompt skill or the community `prompt-engineer` mirror without product direction.

### Structured outputs

Source: `https://developers.openai.com/api/docs/guides/structured-outputs`

Verified excerpts:

> “Structured Outputs is a feature that ensures the model will always generate responses that adhere to your supplied JSON Schema”

> “Simpler prompting: No need for strongly worded prompts to achieve consistent formatting”

> “Structured Outputs is the evolution of JSON mode. While both ensure valid JSON is produced, only Structured Outputs ensure schema adherence.”

> “We recommend always using Structured Outputs instead of JSON mode when possible.”

Use in Rin prompt work:

- Prefer schema validation over repeated “return valid JSON” wording.
- Still define incompatible-input behavior and refusal handling.

### OpenAI evals

Source: `https://developers.openai.com/api/docs/guides/evaluation-best-practices`

Verified excerpts:

> “Evals are structured tests for measuring a model’s performance.”

> “Adopt eval-driven development: Evaluate early and often.”

> “Design task-specific evals: Make tests reflect model capability in real-world distributions.”

> “Log everything”

> “Automate when possible”

> “It’s a journey, not a destination: Evaluation is a continuous process.”

> “Maintain agreement: Use human feedback to calibrate automated scoring.”

> “Vibe-based evals: Using ‘it seems like it’s working’ as an evaluation strategy”

Use in Rin prompt work:

- Add measurable tests for reusable prompts.
- Keep human review for product taste, but do not replace tests with taste.

## Google Gemini

Source: `https://ai.google.dev/gemini-api/docs/prompting-strategies`

Verified excerpts:

> “Prompt engineering is iterative. These guidelines and templates are starting points. Experiment and refine based on your specific use cases and observed model responses.”

> “An effective and efficient way to customize model behavior is to provide it with clear and specific instructions.”

> “You can include examples in the prompt that show the model what getting it right looks like.”

> “Use specific and varied examples to help the model narrow its focus and generate more accurate results.”

> “We recommend to always include few-shot examples in your prompts.”

> “While you can specify the format of simple JSON response objects using prompts, we recommend using Gemini API's structured output feature when specifying a more complex JSON Schema for the response.”

> “They respond best to prompts that are direct, well-structured, and clearly define the task and any constraints.”

> “Use consistent structure: Employ clear delimiters to separate different parts of your prompt. XML-style tags (e.g., `<context>`, `<task>`) or Markdown headings are effective.”

> “Structure for long contexts: When providing large amounts of context (e.g., documents, code), supply all the context first. Place your specific instructions or questions at the very end of the prompt.”

Use in Rin prompt work:

- For Gemini prompts, examples are a stronger default than for GPT-5.5 migrations.
- Use Gemini structured output for complex JSON schema.
- Put long context before the specific question when following Gemini guidance.

## Microsoft / Azure OpenAI / Foundry

Source: `https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/prompt-engineering`

Verified excerpts:

> “These techniques aren't recommended for reasoning models like gpt-5 and o-series models.”

> “Prompt construction can be difficult. In practice, the prompt acts to help the model complete the desired task, but it's more of an art than a science”

> “it's important to understand that each model behaves differently, so the learnings might not apply equally to all models.”

> “the goal of this breakdown is to provide a relatively simple way to think about prompt construction.”

> “Instructions are likely the most commonly used prompt component.”

> “Primary content refers to text that the model processes or transforms.”

> “Successful prompts often rely on the practice of "one-shot" or "few-shot" learning.”

Use in Rin prompt work:

- Use Microsoft guidance for Azure deployment context and basic component vocabulary.
- Do not apply Microsoft’s non-reasoning-model techniques to GPT-5/o-series reasoning models when the page warns against it.
