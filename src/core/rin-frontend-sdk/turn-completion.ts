import {
  countToolCalls,
  isAssistantFailedMessage,
} from "../message-content.js";
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

export function isRinTerminalAssistantMessage(message: any) {
  if (safeString(message?.role).trim() !== "assistant") return false;
  return (
    isAssistantFailedMessage(message) || countToolCalls(message?.content) === 0
  );
}

export function resolveRinTurnCompletionFromAssistantMessage(
  message: any,
): RinTurnCompletionResolution | null {
  if (!isRinTerminalAssistantMessage(message)) return null;
  return resolveRinTurnCompletionFromMessages([message]);
}

export function resolveRinTerminalTurnCompletionFromMessages(messages: any[]) {
  const terminalMessage = [...messages]
    .reverse()
    .find(isRinTerminalAssistantMessage);
  return terminalMessage
    ? resolveRinTurnCompletionFromMessages([terminalMessage])
    : null;
}

export function resolveRinTurnCompletionFromMessages(
  messages: any[],
): RinTurnCompletionResolution {
  return {
    messages,
    completion: resolveTurnCompletion({ messages }),
  };
}

export function resolveRinTurnFailureMessage(
  session: any,
  messages: any[],
  options: { retryFailureMessage?: string } = {},
) {
  for (const message of [...messages].reverse()) {
    if (safeString(message?.role).trim() !== "assistant") continue;
    const errorMessage = safeString(
      message?.errorMessage || message?.error,
    ).trim();
    if (errorMessage) return errorMessage;
    if (isAssistantFailedMessage(message)) {
      return safeString(message?.stopReason).trim() === "aborted"
        ? "Agent turn was aborted."
        : "Agent producer failed.";
    }
  }

  const retryFailureMessage = safeString(options.retryFailureMessage).trim();
  if (retryFailureMessage) return retryFailureMessage;

  const stateError = safeString(session?.agent?.state?.errorMessage).trim();
  if (stateError) return stateError;
  return "";
}
