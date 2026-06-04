# Initialization

Use this when the user asks to initialize Rin, restart initial setup, reset long-term assistant preferences, or establish durable preferences for future sessions.

Initialization is a short preference-setting conversation. Keep it focused on durable guidance that will make future sessions behave consistently.

## Conversation contract

- Ask one focused question at a time.
- Wait for the user's answer before continuing.
- Save confirmed durable guidance and leave unknown profile details blank until the user provides them.
- Treat volunteered style or configuration preferences as ordinary durable preference/configuration material.
- Keep the conversation short: collect the next useful durable preference, persist it, summarize it, and stop or ask whether to continue.

## What to collect

Collect compact durable preferences that should influence future sessions:

- assistant identity, role, voice, tone, boundaries, and standing response expectations;
- how to address the user and important people;
- stable user identity facts the assistant should always remember;
- stable working style preferences, such as concision, verification expectations, or planning style;
- durable methodology or decision rules the user wants Rin to follow;
- recurring responsibilities or domains that should later become skills or task workflows.

Route other material to its proper surface:

- one-time tasks, reminders, shopping lists, day plans, and temporary state go to the active task or scheduling workflow;
- long procedures, checklists, troubleshooting playbooks, and domain manuals go to skills;
- raw chat history, transcripts, evidence, and provenance stay in memory/retrieval surfaces.

## Conversation flow

1. Start with a short acknowledgement and one focused question.
2. Classify the answer immediately: durable baseline, skill/workflow candidate, memory/evidence-only, temporary task, or skip.
3. Ask a narrow follow-up when it changes the durable guidance.
4. After enough signal is collected, persist the distilled guidance through the current self-improve write path.
5. Summarize the user-facing durable preferences saved or intentionally routed elsewhere.
6. Ask whether the user wants to add or adjust one more preference; stop cleanly when they decline.

Good first questions are narrow and durable:

```text
What role and tone should Rin keep across future sessions?
```

```text
How should Rin address you by default?
```

```text
Is there one working-style rule Rin should always follow?
```

Prefer narrow questions over broad forms such as “tell me everything about yourself” or long questionnaires covering every capability.

## Persistence targets

Use `docs/memory-layering.md` to choose the destination. For initialization, the usual self-improve prompt baselines are:

- `agent_profile`: stable assistant role, voice, behavior style, and standing response expectations.
- `user_profile`: stable user identity and compact always-relevant user facts.
- `core_doctrine`: durable methodology, values, and decision rules.

Initialization has enough durable baseline coverage when confirmed guidance for `agent_profile` and `user_profile` is present. Add `core_doctrine` when the user gives durable methodology preferences.

Prompt baseline rules:

- Write compact distilled target behavior instead of transcript excerpts.
- Use one dense line per topic.
- Replace or merge overlapping lines instead of appending duplicates.
- Keep baselines short; long instructions belong elsewhere.

Use a skill instead of a prompt baseline when the material needs:

- steps;
- examples;
- exceptions;
- troubleshooting;
- domain detail;
- a checklist;
- recurring operational workflow.

Use memory/retrieval surfaces when original wording, evidence, chronology, or provenance matters. Keep prompt baselines as distilled guidance rather than raw transcripts.

## Reporting success

When reporting initialization progress:

- say which durable preferences were saved in clear words;
- mention routed items when useful, such as “I kept the temporary reminder in the active task flow rather than the long-term profile”;
- keep storage mechanics brief unless the user asks for details;
- when the answer produced zero durable guidance, say that clearly and ask one focused next question or stop if the user declined.

## Read next

- Destination choice between memory evidence and self-improve guidance: `docs/memory-layering.md`.
- Prompt baseline and skill distillation contract: `docs/self-improve-distillation.md`.
- Prompt-writing discipline for durable instructions: `builtin-skills/rin-prompt-engineering/SKILL.md`.
- Scheduled reminders or recurring follow-ups: `docs/agent-sdk.md` and `docs/scheduled-tasks.md`.
- Chat identity, logs, and platform metadata: `docs/chat-bridge.md`.
