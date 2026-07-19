import { isAssistantFailedMessage } from "../message-content.js";
import { resolveTurnCompletion } from "../session/turn-result.js";
import { isRinTerminalAssistantMessage } from "./turn-completion.js";
import { safeString } from "../text-utils.js";

export type RinSubmittedTurnResolution =
  | { submitted: true }
  | { superseded: true; sessionId?: string; sessionFile?: string }
  | {
      error: string;
      sessionId?: string;
      sessionFile?: string;
    }
  | {
      finalText: string;
      result?: unknown;
      sessionId?: string;
      sessionFile?: string;
    }
  | null;

function messageValue(message: unknown) {
  const value = message && typeof message === "object" ? (message as any) : {};
  return value?.message && typeof value.message === "object"
    ? value.message
    : value;
}

function messageRole(message: unknown) {
  return safeString(messageValue(message)?.role).trim();
}

function messageText(message: unknown) {
  const value = messageValue(message);
  const content = value?.content;
  if (typeof content === "string") return safeString(content).trim();
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : safeString(part?.text || part?.content || part?.attrs?.content),
      )
      .join("")
      .trim();
  }
  return safeString(value?.text).trim();
}

function messageRequestTag(message: unknown) {
  const outer = message && typeof message === "object" ? (message as any) : {};
  return safeString(
    messageValue(message)?.requestTag || outer?.requestTag,
  ).trim();
}

function messageTimestampMs(message: unknown) {
  const outer = message && typeof message === "object" ? (message as any) : {};
  const raw = messageValue(message)?.timestamp ?? outer?.timestamp;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(safeString(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

function messageFailureError(message: unknown) {
  const value = messageValue(message);
  if (!isAssistantFailedMessage(value)) return "";
  return safeString(value?.errorMessage || value?.error).trim();
}

function findSubmittedTurnFailure(messages: unknown[]) {
  for (const message of [...messages].reverse()) {
    const error = messageFailureError(message);
    if (error) return error;
  }
  return "";
}

export function resolveSubmittedTurnFromMessages(
  messages: unknown[],
  input: { text: string; sentAt?: number; requestTag?: string },
  options: { turnActive?: boolean } = {},
): RinSubmittedTurnResolution {
  const sentAt = Number(input.sentAt || 0);
  const validSentAt = Number.isFinite(sentAt) && sentAt > 0;
  const promptText = safeString(input.text).trim();
  const requestTag = safeString(input.requestTag).trim();
  if (!promptText || (!requestTag && !validSentAt)) return null;

  let submittedIndex = -1;
  if (requestTag) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (messageRole(message) !== "user") continue;
      if (messageRequestTag(message) !== requestTag) continue;
      submittedIndex = index;
      break;
    }
  }
  if (submittedIndex < 0) {
    const legacyMatches: number[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (messageRole(message) !== "user") continue;
      if (messageRequestTag(message)) continue;
      if (!validSentAt || messageTimestampMs(message) < sentAt) continue;
      if (messageText(message) !== promptText) continue;
      legacyMatches.push(index);
    }
    if (legacyMatches.length === 1) submittedIndex = legacyMatches[0];
  }
  if (submittedIndex < 0) return null;

  const turnMessages = messages.slice(submittedIndex + 1);
  let hasLaterUserBeforeCompletion = false;
  let terminalMessage: any = null;
  for (const rawMessage of turnMessages) {
    const message = messageValue(rawMessage);
    if (messageRole(message) === "user") {
      if (terminalMessage) break;
      hasLaterUserBeforeCompletion = true;
      continue;
    }
    if (isRinTerminalAssistantMessage(message)) {
      terminalMessage = message;
    }
  }
  if (hasLaterUserBeforeCompletion) return { superseded: true };
  if (!terminalMessage) {
    if (options.turnActive) return { submitted: true };
    const error = findSubmittedTurnFailure(turnMessages);
    if (error) return { error };
    return { submitted: true };
  }
  const terminalError =
    messageFailureError(terminalMessage) ||
    (isAssistantFailedMessage(terminalMessage)
      ? safeString(terminalMessage?.stopReason).trim() === "aborted"
        ? "Agent turn was aborted."
        : "Agent producer failed."
      : "");
  if (terminalError) {
    return options.turnActive ? { submitted: true } : { error: terminalError };
  }
  const completion = resolveTurnCompletion({ messages: [terminalMessage] });
  return {
    finalText: completion.finalText,
    result: completion.result,
  };
}
