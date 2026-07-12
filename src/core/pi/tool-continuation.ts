import { extractToolCallParts } from "../message-content.js";
import { safeString } from "../text-utils.js";

const PI_INCOMPLETE_ASSISTANT_STOP_REASONS = new Set(["error", "aborted"]);

type MessageLike = {
  role?: unknown;
  stopReason?: unknown;
  content?: unknown;
};

function messageLike(value: unknown): MessageLike {
  return value && typeof value === "object" ? (value as MessageLike) : {};
}

function isAssistantMessage(message: unknown) {
  return safeString(messageLike(message).role).trim() === "assistant";
}

function isPiCompleteAssistantMessage(message: unknown) {
  if (!isAssistantMessage(message)) return false;
  return !PI_INCOMPLETE_ASSISTANT_STOP_REASONS.has(
    safeString(messageLike(message).stopReason).trim(),
  );
}

export function buildPiToolContinuationPlan(messages: unknown[]) {
  const list = Array.isArray(messages) ? messages : [];
  const visibleMessageIndexes = new Set<number>();
  const visibleToolCallPartsByMessageIndex = new Map<
    number,
    ReturnType<typeof extractToolCallParts>
  >();
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    if (!isPiCompleteAssistantMessage(message)) continue;
    visibleMessageIndexes.add(index);
    visibleToolCallPartsByMessageIndex.set(
      index,
      extractToolCallParts(messageLike(message).content),
    );
  }
  return { visibleMessageIndexes, visibleToolCallPartsByMessageIndex };
}

export function extractAssistantToolCallParts(message: unknown) {
  if (!isAssistantMessage(message)) return [];
  return extractToolCallParts(messageLike(message).content);
}

export function extractAssistantToolCallIds(message: unknown) {
  return extractAssistantToolCallParts(message)
    .map((part) => safeString(part?.id).trim())
    .filter(Boolean);
}

export function extractPiContinuableToolCallParts(message: unknown) {
  if (!isPiCompleteAssistantMessage(message)) return [];
  return extractAssistantToolCallParts(message);
}

export function extractPiContinuableToolCallIds(message: unknown) {
  return extractPiContinuableToolCallParts(message)
    .map((part) => safeString(part?.id).trim())
    .filter(Boolean);
}
