import {
  applyFrontendBuiltinCommandText,
  DEFAULT_RIN_FRONTEND_COMMAND_RESPONSES,
  type RinFrontendCommandResponses,
} from "../rin-frontend-sdk/command-responses.js";

export type ChatCommandResponses = RinFrontendCommandResponses;

export const DEFAULT_CHAT_COMMAND_RESPONSES = {
  ...DEFAULT_RIN_FRONTEND_COMMAND_RESPONSES,
  compactionSummaryText: "{summary}",
} satisfies RinFrontendCommandResponses;

export function resolveChatCommandResponses(
  configured?: Partial<ChatCommandResponses>,
  baseline: ChatCommandResponses = DEFAULT_CHAT_COMMAND_RESPONSES,
) {
  const source = configured && typeof configured === "object" ? configured : {};
  return Object.fromEntries(
    Object.entries(baseline).map(([key, fallback]) => {
      const value = source[key as keyof ChatCommandResponses];
      return [
        key,
        typeof value === "string" && value.trim() ? value : fallback,
      ];
    }),
  ) as ChatCommandResponses;
}

export function applyChatBuiltinCommandText(
  commandName: string,
  data: unknown,
  responses: ChatCommandResponses,
) {
  return applyFrontendBuiltinCommandText(commandName, data, responses, {
    preferConfiguredText: true,
  });
}
