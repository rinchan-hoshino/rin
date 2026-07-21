import {
  countToolCalls,
  isAssistantFailedMessage,
} from "../message-content.js";
import { safeString } from "../text-utils.js";

export type RinTurnMessageClassification = "nonterminal" | "complete" | "error";

export function rinTurnMessageValue(message: unknown) {
  const value = message && typeof message === "object" ? (message as any) : {};
  return value?.message && typeof value.message === "object"
    ? value.message
    : value;
}

function hasRinSessionSummaryMarker(value: any) {
  const type = safeString(value?.type).trim();
  const role = safeString(value?.role).trim();
  const customType = safeString(value?.customType).trim();
  return (
    type === "compaction" ||
    role === "compactionSummary" ||
    role === "branchSummary" ||
    customType === "session_summary" ||
    Boolean(value?.summaryEntry)
  );
}

export function isRinSessionSummaryMessage(message: unknown) {
  const outer = message && typeof message === "object" ? (message as any) : {};
  const value = rinTurnMessageValue(outer);
  return (
    hasRinSessionSummaryMarker(outer) ||
    (value !== outer && hasRinSessionSummaryMarker(value))
  );
}

export function classifyRinTurnMessage(
  message: unknown,
): RinTurnMessageClassification {
  if (isRinSessionSummaryMessage(message)) return "nonterminal";
  const value = rinTurnMessageValue(message);
  if (safeString(value?.role).trim() !== "assistant") return "nonterminal";
  if (isAssistantFailedMessage(value)) return "error";
  return countToolCalls(value?.content) > 0 ? "nonterminal" : "complete";
}

export function isRinTerminalAssistantMessage(message: unknown) {
  return classifyRinTurnMessage(message) !== "nonterminal";
}

export function findRinTerminalMessage(messages: unknown[]) {
  for (const rawMessage of [...messages].reverse()) {
    if (classifyRinTurnMessage(rawMessage) === "nonterminal") continue;
    return rinTurnMessageValue(rawMessage);
  }
  return null;
}
