import { extractToolCallParts } from "../message-content.js";
import { isPiCompactSkillReadCall } from "../pi/private-api.js";

export const RIN_SESSION_PRUNING_PROTECT_RECENT_TURNS = 4;
export const RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT =
  "old tool result omitted";
type SessionPruningOptions = {
  protectRecentTurns?: number;
  cwd?: string;
};

export function normalizeProtectRecentTurns(value: unknown) {
  const turns = Number(value);
  if (!Number.isFinite(turns) || turns <= 0) {
    return RIN_SESSION_PRUNING_PROTECT_RECENT_TURNS;
  }
  return Math.floor(turns);
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

function createProviderBoundPrunePlan(
  messages: any[],
  options: SessionPruningOptions = {},
) {
  const input = Array.isArray(messages) ? messages : [];
  const protectedStart = findProtectedContextStart(
    input,
    normalizeProtectRecentTurns(options.protectRecentTurns),
  );
  const replacements = new Map<any, any>();
  const protectedToolResultIds = collectProtectedToolResultIds(
    input,
    String(options.cwd || process.cwd()),
  );
  let changed = false;
  const pruned = input.map((message, index) => {
    if (index < protectedStart && isToolResultMessage(message)) {
      if (isProtectedToolResult(message, protectedToolResultIds))
        return message;
      if (isAlreadyOmitted(message?.content)) return message;
      const replacement = {
        ...message,
        content: omittedContentFor(message?.content),
      };
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
