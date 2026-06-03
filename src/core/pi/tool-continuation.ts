import { extractToolCallParts } from "../message-content.js";
import { safeString } from "../text-utils.js";

const PI_INCOMPLETE_ASSISTANT_STOP_REASONS = new Set(["error", "aborted"]);

function isAssistantMessage(message: any) {
  return safeString(message?.role).trim() === "assistant";
}

function isPiCompleteAssistantMessage(message: any) {
  if (!isAssistantMessage(message)) return false;
  return !PI_INCOMPLETE_ASSISTANT_STOP_REASONS.has(
    safeString(message?.stopReason).trim(),
  );
}

export function buildPiToolContinuationPlan(messages: any[]) {
  const list = Array.isArray(messages) ? messages : [];
  const visibleMessageIndexes = new Set<number>();
  const visibleToolCallPartsByMessageIndex = new Map<number, any[]>();

  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    if (!isAssistantMessage(message)) continue;
    if (!isPiCompleteAssistantMessage(message)) continue;
    visibleMessageIndexes.add(index);
    visibleToolCallPartsByMessageIndex.set(
      index,
      extractToolCallParts(message?.content),
    );
  }

  return { visibleMessageIndexes, visibleToolCallPartsByMessageIndex };
}

export function extractAssistantToolCallParts(message: any) {
  if (!isAssistantMessage(message)) return [];
  return extractToolCallParts(message?.content);
}

export function extractAssistantToolCallIds(message: any) {
  return extractAssistantToolCallParts(message)
    .map((part: any) => safeString(part?.id).trim())
    .filter(Boolean);
}

export function extractPiContinuableToolCallParts(message: any) {
  if (!isPiCompleteAssistantMessage(message)) return [];
  return extractAssistantToolCallParts(message);
}

export function extractPiContinuableToolCallIds(message: any) {
  return extractPiContinuableToolCallParts(message)
    .map((part: any) => safeString(part?.id).trim())
    .filter(Boolean);
}
