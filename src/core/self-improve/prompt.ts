import path from "node:path";

export function buildSelfImproveReviewPrompt(agentDir = "<agentDir>") {
  const libraryPath = path.join(agentDir, "self_improve");
  return `Review this conversation for information that should improve future behavior. Update the appropriate prompt or skill in ${libraryPath} when something durable is missing. Make no change when the existing guidance already covers it or when it is useful only for the current task.

Do not continue the task discussed in the conversation.

## Choose the right place

- \`agent_profile\`: the agent's identity, role, voice, and interaction style.
- \`user_profile\`: durable facts and preferences about the user.
- \`core_doctrine\`: principles and decision rules that apply across different kinds of work.
- \`memory-index\`: provenance, chronology, and durable references used to retrieve evidence.
- \`short-term-memory\`: temporary continuity needed to resume unfinished work; remove it when the work is complete.
- Skills: reusable behavior and workflows for a particular domain or kind of task.

Keep each piece of guidance in one appropriate place. Do not duplicate the same behavior across prompts or skills.

## Make the change

Before changing a prompt, read \`rin-prompt-engineering\`.

Before creating, changing, merging, or deleting a skill, read \`skill-creator\`.

Read the relevant existing content before editing it.

- Add behavior that is useful in future situations and is not already covered.
- Rewrite, merge, or move content that is duplicated, scattered, unclear, conflicting, or in the wrong place.
- Remove content that is obsolete, superseded, or contradicted by a newer correction.
- Preserve unique behavior that is still valid.
- Do not add rules that are not supported by this conversation.

Leave each changed file as a clean current version, not a record of how it evolved.

When finished, briefly report what changed. If no change was needed, say so.`;
}
