import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { Type } from "typebox";

import { resolveAgentDir } from "./agent-dir.js";
import {
  buildCompiledSelfImprovePrompt,
  buildSystemPromptSelfImprove,
  formatSelfImproveAgentResult,
  formatSelfImproveResult,
} from "./format.js";
import {
  buildOnboardingPrompt,
  getOnboardingState,
  isOnboardingActive,
  markOnboardingPrompted,
  refreshOnboardingCompletion,
} from "./onboarding.js";

export { resolveAgentDir } from "./agent-dir.js";

export const selfImproveActionParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("save_self_improve_prompt"),
      Type.Literal("remove_self_improve_prompt"),
      Type.Literal("compile"),
    ],
    {
      description:
        "Self-improve action. Allowed values: `save_self_improve_prompt`, `remove_self_improve_prompt`, or `compile`.",
    },
  ),
  id: Type.Optional(Type.String()),
  path: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  content: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(Type.String())),
  aliases: Type.Optional(Type.Array(Type.String())),
  selfImprovePromptSlot: Type.Optional(
    Type.Union(
      [
        Type.Literal("agent_profile"),
        Type.Literal("user_profile"),
        Type.Literal("core_doctrine"),
      ],
      {
        description:
          "Self-improve prompt slot name. Allowed values: `agent_profile`, `user_profile`, or `core_doctrine`. Durable facts and knowledge belong in skills.",
      },
    ),
  ),
  scope: Type.Optional(
    Type.Union(
      [
        Type.Literal("global"),
        Type.Literal("domain"),
        Type.Literal("project"),
        Type.Literal("session"),
      ],
      {
        description:
          "Optional self-improve scope. Allowed values: `global`, `domain`, `project`, or `session`.",
      },
    ),
  ),
  kind: Type.Optional(
    Type.Union(
      [
        Type.Literal("skill"),
        Type.Literal("instruction"),
        Type.Literal("rule"),
        Type.Literal("fact"),
        Type.Literal("index"),
      ],
      {
        description:
          "Optional self-improve kind. Allowed values: `skill`, `instruction`, `rule`, `fact`, or `index`.",
      },
    ),
  ),
});

export async function loadSelfImproveStore() {
  const moduleUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "store.js"),
  ).href;
  return await import(moduleUrl);
}

export async function executeSelfImproveTool(params: any) {
  const service = await loadSelfImproveStore();
  return await service.executeSelfImproveAction(params, resolveAgentDir());
}

export {
  buildOnboardingPrompt,
  formatSelfImproveAgentResult,
  formatSelfImproveResult,
  getOnboardingState,
  isOnboardingActive,
  markOnboardingPrompted,
  refreshOnboardingCompletion,
};

export async function compileSelfImprovePrompt() {
  const service = await loadSelfImproveStore();
  const compiled = await service.compileSelfImprove({}, resolveAgentDir());
  return {
    compiled,
    prompt: buildCompiledSelfImprovePrompt(compiled),
    systemPrompt: buildSystemPromptSelfImprove(compiled),
  };
}
