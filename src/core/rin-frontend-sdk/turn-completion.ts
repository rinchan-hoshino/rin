import { resolveTurnCompletion } from "../session/turn-result.js";
import { safeString } from "../text-utils.js";

export type RinTurnCompletionResolution = {
  messages: any[];
  completion: ReturnType<typeof resolveTurnCompletion>;
};

export function resolveRinTurnCompletionFromTurnResult(
  value: any,
): RinTurnCompletionResolution {
  const result = value?.result ?? value;
  return {
    messages: [],
    completion: resolveTurnCompletion({
      result,
      finalText: value?.finalText ?? result?.finalText,
    }),
  };
}

export function resolveRinTurnCompletionFromAssistantMessage(
  message: any,
): RinTurnCompletionResolution | null {
  if (safeString(message?.role).trim() !== "assistant") return null;
  return {
    messages: [message],
    completion: resolveTurnCompletion({ messages: [message] }),
  };
}

export function resolveRinTurnFailureMessage(
  session: any,
  messages: any[],
  options: { retryFailureMessage?: string } = {},
) {
  const retryFailureMessage = safeString(options.retryFailureMessage).trim();
  if (retryFailureMessage) return retryFailureMessage;

  const stateError = safeString(session?.agent?.state?.errorMessage).trim();
  if (stateError) return stateError;

  for (const message of [...messages].reverse()) {
    if (safeString(message?.role).trim() !== "assistant") continue;
    const errorMessage = safeString(message?.errorMessage).trim();
    if (errorMessage) return errorMessage;
  }
  return "";
}
