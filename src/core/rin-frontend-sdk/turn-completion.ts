import { isAssistantFailedMessage } from "../message-content.js";
import {
  classifyRinTurnMessage,
  findRinTerminalMessage,
  isRinSessionSummaryMessage,
  isRinTerminalAssistantMessage,
  rinTurnMessageValue,
} from "../session/turn-message.js";
import { resolveTurnCompletion } from "../session/turn-result.js";
import { safeString } from "../text-utils.js";

export {
  classifyRinTurnMessage,
  isRinTerminalAssistantMessage,
} from "../session/turn-message.js";

export type RinTurnCompletionResolution = {
  messages: any[];
  completion: ReturnType<typeof resolveTurnCompletion>;
};

export type RinTurnTerminalOutcome =
  | { kind: "absent" }
  | {
      kind: "complete";
      resolution: RinTurnCompletionResolution;
      comparison: "structured" | "text";
    }
  | {
      kind: "error";
      resolution: RinTurnCompletionResolution;
      error: string;
    };

export const RIN_TURN_TERMINAL_ABSENT: RinTurnTerminalOutcome = {
  kind: "absent",
};

export function areRinTurnTerminalOutcomesConsistent(
  authoritative: RinTurnTerminalOutcome,
  evidence: RinTurnTerminalOutcome,
) {
  if (authoritative.kind === "absent" || evidence.kind === "absent") {
    return true;
  }
  if (authoritative.kind !== evidence.kind) return false;
  if (authoritative.kind === "error" && evidence.kind === "error") {
    return !(
      authoritative.error &&
      evidence.error &&
      authoritative.error !== evidence.error
    );
  }
  if (authoritative.kind !== "complete" || evidence.kind !== "complete") {
    return true;
  }
  if (authoritative.comparison === "text") {
    return (
      authoritative.resolution.completion.finalText ===
      evidence.resolution.completion.finalText
    );
  }
  return (
    JSON.stringify(authoritative.resolution.completion.result.messages) ===
    JSON.stringify(evidence.resolution.completion.result.messages)
  );
}

export function resolveRinAuthoritativeTurnTerminalOutcome(
  direct: RinTurnTerminalOutcome,
  scoped: RinTurnTerminalOutcome,
  observed: RinTurnTerminalOutcome = RIN_TURN_TERMINAL_ABSENT,
) {
  const authoritative = direct.kind !== "absent" ? direct : scoped;
  if (authoritative.kind === "absent") return authoritative;
  for (const evidence of [scoped, observed]) {
    if (evidence === authoritative) continue;
    if (!areRinTurnTerminalOutcomesConsistent(authoritative, evidence)) {
      throw new Error("rin_turn_terminal_conflict");
    }
  }
  return authoritative;
}

function messageFailureError(message: any) {
  const error = safeString(message?.errorMessage || message?.error).trim();
  if (error) return error;
  return safeString(message?.stopReason).trim() === "aborted"
    ? "Agent turn was aborted."
    : "Agent producer failed.";
}

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

export function resolveRinTurnTerminalOutcomeFromTurnResult(
  value: any,
): RinTurnTerminalOutcome {
  if (!value || typeof value !== "object") return RIN_TURN_TERMINAL_ABSENT;
  const result = value.result ?? value;
  const hasStructuredResult = Array.isArray(result?.messages);
  const hasTextResult =
    typeof value.finalText === "string" ||
    typeof result?.finalText === "string";
  if (!hasStructuredResult && !hasTextResult) {
    return RIN_TURN_TERMINAL_ABSENT;
  }
  if (
    hasStructuredResult &&
    result.messages.length > 0 &&
    result.messages.some((message: unknown) => {
      const messageValue = rinTurnMessageValue(message);
      return (
        safeString(messageValue?.role).trim().length > 0 ||
        isRinSessionSummaryMessage(message)
      );
    })
  ) {
    return resolveRinTurnTerminalOutcomeFromMessages(result.messages);
  }
  return {
    kind: "complete",
    resolution: resolveRinTurnCompletionFromTurnResult(value),
    comparison: hasStructuredResult ? "structured" : "text",
  };
}

export function resolveRinTurnTerminalOutcomeFromAssistantMessage(
  message: any,
): RinTurnTerminalOutcome {
  const classification = classifyRinTurnMessage(message);
  if (classification === "nonterminal") return RIN_TURN_TERMINAL_ABSENT;
  const messageValue = rinTurnMessageValue(message);
  const resolution = resolveRinTurnCompletionFromMessages([messageValue]);
  return classification === "error"
    ? {
        kind: "error",
        resolution,
        error: messageFailureError(messageValue),
      }
    : { kind: "complete", resolution, comparison: "structured" };
}

export function resolveRinTurnTerminalOutcomeFromMessages(
  messages: any[],
): RinTurnTerminalOutcome {
  const terminalMessage = findRinTerminalMessage(messages);
  return terminalMessage
    ? resolveRinTurnTerminalOutcomeFromAssistantMessage(terminalMessage)
    : RIN_TURN_TERMINAL_ABSENT;
}

export function resolveRinTurnCompletionFromAssistantMessage(
  message: any,
): RinTurnCompletionResolution | null {
  const outcome = resolveRinTurnTerminalOutcomeFromAssistantMessage(message);
  return outcome.kind === "absent" ? null : outcome.resolution;
}

export function resolveRinTerminalTurnCompletionFromMessages(messages: any[]) {
  const outcome = resolveRinTurnTerminalOutcomeFromMessages(messages);
  return outcome.kind === "absent" ? null : outcome.resolution;
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
