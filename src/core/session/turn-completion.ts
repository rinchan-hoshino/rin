import {
  extractToolCallParts,
  isAssistantFailedMessage,
} from "../message-content.js";
import {
  classifyRinTurnMessage,
  findRinTerminalMessage,
  isRinSessionSummaryMessage,
  isRinTerminalAssistantMessage,
  rinTurnMessageValue,
} from "../session/turn-message.js";
import {
  buildTurnResultFromAssistantMessage,
  resolveTurnCompletion,
} from "../session/turn-result.js";
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

export const RIN_EMPTY_AGENT_RESPONSE_ERROR =
  "Agent returned an empty response.";

function rejectEmptyRinTurnCompletion(
  resolution: RinTurnCompletionResolution,
  comparison: "structured" | "text",
): RinTurnTerminalOutcome {
  const messages = resolution.completion.result.messages;
  if (resolution.completion.finalText || messages.length > 0) {
    return { kind: "complete", resolution, comparison };
  }
  return {
    kind: "error",
    resolution,
    error: RIN_EMPTY_AGENT_RESPONSE_ERROR,
  };
}

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
  return rejectEmptyRinTurnCompletion(
    resolveRinTurnCompletionFromTurnResult(value),
    hasStructuredResult ? "structured" : "text",
  );
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
    : rejectEmptyRinTurnCompletion(resolution, "structured");
}

export function resolveRinTurnTerminalOutcomeFromMessages(
  messages: any[],
): RinTurnTerminalOutcome {
  const terminalMessage = findRinTerminalMessage(messages);
  return terminalMessage
    ? resolveRinTurnTerminalOutcomeFromAssistantMessage(terminalMessage)
    : RIN_TURN_TERMINAL_ABSENT;
}

function lastRinTerminalMessageIndex(messages: any[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRinSessionSummaryMessage(messages[index])) continue;
    if (classifyRinTurnMessage(messages[index]) !== "nonterminal") return index;
  }
  return -1;
}

function rinConversationRole(rawMessage: any) {
  const role = rinTurnMessageValue(rawMessage)?.role;
  return typeof role === "string" ? role : "";
}

function isRinConversationRecord(rawMessage: any) {
  if (isRinSessionSummaryMessage(rawMessage)) return true;
  const outer = rawMessage && typeof rawMessage === "object" ? rawMessage : {};
  const value = rinTurnMessageValue(outer);
  const outerType = safeString(outer?.type);
  if (value === outer) {
    if (outerType) return false;
  } else if (outerType && outerType !== "message") {
    return false;
  }
  if (
    safeString(outer?.customType) ||
    (value !== outer && safeString(value?.type)) ||
    safeString(value?.customType)
  ) {
    return false;
  }
  const role = rinConversationRole(rawMessage);
  return role === "user" || role === "assistant" || role === "toolResult";
}

function lastPiConversationMessageIndex(messages: any[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const rawMessage = messages[index];
    if (isRinSessionSummaryMessage(rawMessage)) continue;
    const role = rinConversationRole(rawMessage);
    if (role === "user" || role === "assistant" || role === "toolResult") {
      return index;
    }
  }
  return -1;
}

function settledTurnMessagesUseOnlyConversationRoles(messages: any[]) {
  return messages.every((rawMessage) => isRinConversationRecord(rawMessage));
}

function settledTurnToolResultsSucceeded(
  messages: any[],
  terminalIndex: number,
) {
  const seenToolCallIds = new Set<string>();
  let pendingToolCallIds: string[] = [];
  for (let index = 0; index < terminalIndex; index += 1) {
    const rawMessage = messages[index];
    if (isRinSessionSummaryMessage(rawMessage)) continue;
    const message = rinTurnMessageValue(rawMessage);
    const role = rinConversationRole(rawMessage);
    if (role === "assistant") {
      if (pendingToolCallIds.length > 0) return false;
      const toolCalls = extractToolCallParts(message?.content);
      if (toolCalls.length === 0) continue;
      if (message?.stopReason !== "toolUse") return false;
      pendingToolCallIds = toolCalls.map((toolCall) =>
        safeString(toolCall?.id || toolCall?.toolCallId),
      );
      for (const toolCallId of pendingToolCallIds) {
        if (!toolCallId.trim() || seenToolCallIds.has(toolCallId)) return false;
        seenToolCallIds.add(toolCallId);
      }
      continue;
    }
    if (role !== "toolResult") {
      if (pendingToolCallIds.length > 0) return false;
      continue;
    }
    const toolCallId = safeString(message?.toolCallId);
    if (
      !toolCallId.trim() ||
      message?.isError !== false ||
      pendingToolCallIds[0] !== toolCallId
    ) {
      return false;
    }
    pendingToolCallIds.shift();
  }
  return pendingToolCallIds.length === 0;
}

function settledTerminalAssistantContentIsExplicitlyEmpty(message: any) {
  if (!Array.isArray(message?.content)) return false;
  return message.content.every((part: any) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return false;
    if (part.type === "thinking") return typeof part.thinking === "string";
    return (
      part.type === "text" &&
      typeof part.text === "string" &&
      part.text.trim().length === 0
    );
  });
}

export function resolveRinSettledTurnTerminalOutcomeFromMessages(
  messages: any[],
): RinTurnTerminalOutcome {
  const terminalOutcome = resolveRinTurnTerminalOutcomeFromMessages(messages);
  const terminalIndex = lastRinTerminalMessageIndex(messages);
  const terminalMessage =
    terminalIndex < 0 ? null : rinTurnMessageValue(messages[terminalIndex]);
  const isEmptyTerminalError =
    terminalOutcome.kind === "error" &&
    terminalOutcome.error === RIN_EMPTY_AGENT_RESPONSE_ERROR;
  if (
    (terminalOutcome.kind !== "complete" && !isEmptyTerminalError) ||
    terminalOutcome.resolution.completion.result.messages.length > 0 ||
    !terminalMessage ||
    terminalMessage.stopReason !== "stop" ||
    !settledTerminalAssistantContentIsExplicitlyEmpty(terminalMessage) ||
    extractToolCallParts(terminalMessage.content).length > 0 ||
    !settledTurnMessagesUseOnlyConversationRoles(messages) ||
    terminalIndex !== lastPiConversationMessageIndex(messages) ||
    !settledTurnToolResultsSucceeded(messages, terminalIndex)
  ) {
    return terminalOutcome;
  }

  for (let index = terminalIndex - 1; index >= 0; index -= 1) {
    const rawMessage = messages[index];
    if (isRinSessionSummaryMessage(rawMessage)) continue;
    const message = rinTurnMessageValue(rawMessage);
    const role = rinConversationRole(rawMessage);
    if (
      role === "user" ||
      classifyRinTurnMessage(rawMessage) !== "nonterminal"
    ) {
      return terminalOutcome;
    }
    if (role !== "assistant") continue;
    const result = buildTurnResultFromAssistantMessage(message, {
      allowToolCalls: true,
    });
    if (!result.messages.length) continue;
    if (
      message?.stopReason !== "toolUse" ||
      !extractToolCallParts(message?.content).length
    ) {
      return terminalOutcome;
    }
    return {
      kind: "complete",
      resolution: {
        messages: [message],
        completion: resolveTurnCompletion({ result }),
      },
      comparison: "structured",
    };
  }

  return terminalOutcome;
}

export class RinTurnSettlementProjector {
  private readonly observedMessages: any[] = [];
  private readonly unsubscribe?: () => void;
  private agentSettled = false;

  constructor(
    session: any,
    onAgentSettled?: (outcome: RinTurnTerminalOutcome) => void,
  ) {
    const rawUnsubscribe = session?.subscribe?.((event: any) => {
      if (event?.type === "message_end") {
        this.observedMessages.push(event.message);
        this.agentSettled = false;
        return;
      }
      if (event?.type !== "agent_settled") return;
      this.agentSettled = true;
      onAgentSettled?.(
        resolveRinSettledTurnTerminalOutcomeFromMessages(this.observedMessages),
      );
    });
    this.unsubscribe =
      typeof rawUnsubscribe === "function" ? rawUnsubscribe : undefined;
  }

  reset() {
    this.observedMessages.length = 0;
    this.agentSettled = false;
  }

  resolve(
    direct: RinTurnTerminalOutcome,
    durableMessages: any[],
  ): RinTurnTerminalOutcome {
    return this.resolveWithSettlement(
      direct,
      durableMessages,
      this.agentSettled,
    );
  }

  resolveUnsettled(
    direct: RinTurnTerminalOutcome,
    durableMessages: any[],
  ): RinTurnTerminalOutcome {
    return this.resolveWithSettlement(direct, durableMessages, false);
  }

  dispose() {
    try {
      this.unsubscribe?.();
    } catch {}
  }

  private resolveWithSettlement(
    direct: RinTurnTerminalOutcome,
    durableMessages: any[],
    settled: boolean,
  ) {
    const resolveMessages = settled
      ? resolveRinSettledTurnTerminalOutcomeFromMessages
      : resolveRinTurnTerminalOutcomeFromMessages;
    return resolveRinAuthoritativeTurnTerminalOutcome(
      direct,
      resolveMessages(durableMessages),
      resolveMessages(this.observedMessages),
    );
  }
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

export function resolveRinTurnFailureMessage(session: any, messages: any[]) {
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

  const stateError = safeString(session?.agent?.state?.errorMessage).trim();
  if (stateError) return stateError;
  return "";
}
