import { rinTurnMessageValue } from "../session/turn-message.js";
import { safeString } from "../text-utils.js";
import {
  classifyRinTurnMessage,
  resolveRinTurnTerminalOutcomeFromAssistantMessage,
} from "./turn-completion.js";

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

function messageRole(message: unknown) {
  return safeString(rinTurnMessageValue(message)?.role).trim();
}

function messageText(message: unknown) {
  const value = rinTurnMessageValue(message);
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
    rinTurnMessageValue(message)?.requestTag || outer?.requestTag,
  ).trim();
}

function messageTimestampMs(message: unknown) {
  const outer = message && typeof message === "object" ? (message as any) : {};
  const raw = rinTurnMessageValue(message)?.timestamp ?? outer?.timestamp;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(safeString(raw));
  return Number.isFinite(parsed) ? parsed : 0;
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
    const message = rinTurnMessageValue(rawMessage);
    if (messageRole(message) === "user") {
      if (terminalMessage) break;
      hasLaterUserBeforeCompletion = true;
      continue;
    }
    if (classifyRinTurnMessage(rawMessage) !== "nonterminal") {
      terminalMessage = message;
    }
  }
  if (hasLaterUserBeforeCompletion) return { superseded: true };
  if (!terminalMessage) return { submitted: true };

  const terminalOutcome =
    resolveRinTurnTerminalOutcomeFromAssistantMessage(terminalMessage);
  if (terminalOutcome.kind === "error") {
    return options.turnActive
      ? { submitted: true }
      : { error: terminalOutcome.error };
  }
  if (terminalOutcome.kind === "absent") return { submitted: true };
  return {
    finalText: terminalOutcome.resolution.completion.finalText,
    result: terminalOutcome.resolution.completion.result,
  };
}
