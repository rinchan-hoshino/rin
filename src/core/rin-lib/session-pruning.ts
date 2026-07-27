import { extractToolCallParts } from "../message-content.js";
import { isPiCompactSkillReadCall } from "../pi/private-api.js";
import { estimateMessageTokens } from "./context-token-estimator.js";

export const RIN_SESSION_PRUNING_PROTECT_RECENT_TURNS = 4;
export const RIN_SESSION_PRUNING_PROTECT_RECENT_MESSAGES = 16;
export const RIN_SESSION_PRUNING_MINIMUM_RECLAIM_TOKENS = 4096;
export const RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT =
  "old tool result omitted";
type SessionPruningOptions = {
  protectRecentTurns?: number;
  protectRecentMessages?: number;
  cwd?: string;
};

function normalizePositiveInteger(value: unknown, fallback: number) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return fallback;
  return Math.floor(normalized);
}

export function normalizeProtectRecentTurns(value: unknown) {
  return normalizePositiveInteger(
    value,
    RIN_SESSION_PRUNING_PROTECT_RECENT_TURNS,
  );
}

export function normalizeProtectRecentMessages(value: unknown) {
  return normalizePositiveInteger(
    value,
    RIN_SESSION_PRUNING_PROTECT_RECENT_MESSAGES,
  );
}

function isUserMessage(message: any) {
  return String(message?.role || "").trim() === "user";
}

function isToolResultMessage(message: any) {
  const role = String(message?.role || "").trim();
  return role === "toolResult" || role === "tool_result";
}

function toolCallId(value: unknown) {
  return String(value || "").trim();
}

function collectProtectedToolResultIds(messages: any[], cwd: string) {
  const protectedIds = new Set<string>();
  for (const message of messages) {
    if (String(message?.role || "").trim() !== "assistant") continue;
    for (const part of extractToolCallParts(message?.content)) {
      if (String(part?.name || part?.toolName || "").trim() !== "read") {
        continue;
      }
      if (!isPiCompactSkillReadCall(part?.arguments, cwd)) continue;
      const id = toolCallId(part?.id);
      if (id) protectedIds.add(id);
    }
  }
  return protectedIds;
}

function isProtectedToolResult(
  message: any,
  protectedToolResultIds: Set<string>,
) {
  const id = toolCallId(message?.toolCallId);
  return Boolean(id && protectedToolResultIds.has(id));
}

export function findProtectedContextStart(
  messages: any[],
  protectRecentTurns: number,
) {
  let turns = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isUserMessage(messages[index])) continue;
    turns += 1;
    if (turns >= protectRecentTurns) return index;
  }
  return 0;
}

function isAlreadyOmitted(content: any) {
  if (typeof content === "string") {
    return content === RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT;
  }
  if (!Array.isArray(content) || content.length !== 1) return false;
  const item = content[0];
  return (
    item &&
    typeof item === "object" &&
    item.type === "text" &&
    item.text === RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT
  );
}

function omittedContentFor(content: any) {
  if (Array.isArray(content)) {
    return [{ type: "text", text: RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT }];
  }
  return RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT;
}

function omittedToolResult(message: any) {
  return { ...message, content: omittedContentFor(message?.content) };
}

function estimateToolResultTokens(message: any) {
  const normalized =
    String(message?.role || "").trim() === "tool_result"
      ? { ...message, role: "toolResult" }
      : message;
  return estimateMessageTokens(normalized);
}

function isTurnBoundaryMessage(message: any) {
  const role = String(message?.role || "").trim();
  return role === "user" || role === "compactionSummary";
}

type TurnRange = { start: number; end: number };

function collectTurnRanges(messages: any[]) {
  const starts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (isTurnBoundaryMessage(messages[index])) starts.push(index);
  }
  if (messages.length > 0 && starts[0] !== 0) starts.unshift(0);
  return starts.map<TurnRange>((start, index) => ({
    start,
    end: starts[index + 1] ?? messages.length,
  }));
}

function indexesBetween(start: number, end: number) {
  return Array.from(
    { length: Math.max(0, end - start) },
    (_, offset) => start + offset,
  );
}

function collectMessageTailPruneIndexes(
  messages: any[],
  candidateIndexes: Iterable<number>,
  protectedToolResultIds: Set<string>,
  allowedIndexes?: Set<number>,
) {
  const indexes = new Set<number>();
  let pendingIndexes: number[] = [];
  let pendingReclaimTokens = 0;

  for (const index of candidateIndexes) {
    if (allowedIndexes && !allowedIndexes.has(index)) continue;
    const message = messages[index];
    if (!isToolResultMessage(message)) continue;
    if (isProtectedToolResult(message, protectedToolResultIds)) continue;
    if (isAlreadyOmitted(message?.content)) continue;

    const replacement = omittedToolResult(message);
    const reclaimTokens = Math.max(
      0,
      estimateToolResultTokens(message) - estimateToolResultTokens(replacement),
    );
    if (!reclaimTokens) continue;

    pendingIndexes.push(index);
    pendingReclaimTokens += reclaimTokens;
    if (pendingReclaimTokens < RIN_SESSION_PRUNING_MINIMUM_RECLAIM_TOKENS) {
      continue;
    }

    for (const pendingIndex of pendingIndexes) indexes.add(pendingIndex);
    pendingIndexes = [];
    pendingReclaimTokens = 0;
  }

  return indexes;
}

function collectCurrentPruneIndexes(
  messages: any[],
  protectedTurnStart: number,
  protectedMessageStart: number,
  protectedToolResultIds: Set<string>,
) {
  const messageTailIndexes = collectMessageTailPruneIndexes(
    messages,
    indexesBetween(protectedTurnStart, protectedMessageStart),
    protectedToolResultIds,
  );
  const indexes = new Set<number>();
  for (let index = 0; index < protectedMessageStart; index += 1) {
    const message = messages[index];
    if (!isToolResultMessage(message)) continue;
    if (isProtectedToolResult(message, protectedToolResultIds)) continue;
    if (isAlreadyOmitted(message?.content)) continue;
    if (index < protectedTurnStart || messageTailIndexes.has(index)) {
      indexes.add(index);
    }
  }
  return indexes;
}

function collectPerTurnPruneIndexes(
  messages: any[],
  currentPruneIndexes: Set<number>,
  protectRecentTurns: number,
  protectRecentMessages: number,
  protectedToolResultIds: Set<string>,
) {
  const ranges = collectTurnRanges(messages);
  const recentRanges = ranges.slice(-protectRecentTurns);
  const oldBoundary =
    ranges.length > protectRecentTurns ? recentRanges[0]?.start || 0 : 0;
  const indexes = new Set<number>();

  for (const index of currentPruneIndexes) {
    if (index < oldBoundary) indexes.add(index);
  }

  for (const range of recentRanges) {
    const candidateIndexes = indexesBetween(
      range.start,
      Math.max(range.start, range.end - protectRecentMessages),
    );
    for (const index of collectMessageTailPruneIndexes(
      messages,
      candidateIndexes,
      protectedToolResultIds,
      currentPruneIndexes,
    )) {
      indexes.add(index);
    }
  }
  return indexes;
}

function createProviderBoundPrunePlan(
  messages: any[],
  options: SessionPruningOptions = {},
) {
  const input = Array.isArray(messages) ? messages : [];
  const protectRecentTurns = normalizeProtectRecentTurns(
    options.protectRecentTurns,
  );
  const protectRecentMessages = normalizeProtectRecentMessages(
    options.protectRecentMessages,
  );
  const protectedTurnStart = findProtectedContextStart(
    input,
    protectRecentTurns,
  );
  const protectedMessageStart = Math.max(
    0,
    input.length - protectRecentMessages,
  );
  const replacements = new Map<any, any>();
  const protectedToolResultIds = collectProtectedToolResultIds(
    input,
    String(options.cwd || process.cwd()),
  );
  // The per-turn policy may restore current omissions, but must never add one.
  const currentPruneIndexes = collectCurrentPruneIndexes(
    input,
    protectedTurnStart,
    protectedMessageStart,
    protectedToolResultIds,
  );
  const perTurnPruneIndexes = collectPerTurnPruneIndexes(
    input,
    currentPruneIndexes,
    protectRecentTurns,
    protectRecentMessages,
    protectedToolResultIds,
  );
  let changed = false;
  const pruned = input.map((message, index) => {
    if (perTurnPruneIndexes.has(index) && isToolResultMessage(message)) {
      if (isProtectedToolResult(message, protectedToolResultIds))
        return message;
      if (isAlreadyOmitted(message?.content)) return message;
      const replacement = omittedToolResult(message);
      replacements.set(message, replacement);
      changed = true;
      return replacement;
    }
    return message;
  });

  return {
    messages: changed ? pruned : input,
    changed,
    replacements,
  };
}

export function pruneSessionContextMessages(
  messages: any[],
  options: SessionPruningOptions = {},
) {
  return createProviderBoundPrunePlan(messages, options).messages;
}
