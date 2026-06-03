import {
  buildPiToolContinuationPlan,
  extractAssistantToolCallIds,
} from "../pi/tool-continuation.js";

export const RIN_SESSION_PRUNING_PROTECT_RECENT_TURNS = 4;
export const RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT =
  "[old tool result omitted to save context.]";

type SessionPruningOptions = {
  protectRecentTurns?: number;
};

function normalizeProtectRecentTurns(value: unknown) {
  const turns = Number(value);
  if (!Number.isFinite(turns) || turns <= 0) {
    return RIN_SESSION_PRUNING_PROTECT_RECENT_TURNS;
  }
  return Math.floor(turns);
}

function isUserMessage(message: any) {
  return String(message?.role || "").trim() === "user";
}

function isAssistantMessage(message: any) {
  return String(message?.role || "").trim() === "assistant";
}

function isToolResultMessage(message: any) {
  const role = String(message?.role || "").trim();
  return role === "toolResult" || role === "tool_result";
}

function findProtectedContextStart(
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

function createProviderVisibleMessagePlan(messages: any[]) {
  const input = Array.isArray(messages) ? messages : [];
  const piPlan = buildPiToolContinuationPlan(input);
  const validToolCallIds = new Set<string>();
  const invalidToolCallIds = new Set<string>();
  const droppedMessages = new Set<any>();
  let changed = false;
  const filtered: any[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const message = input[index];
    if (
      isAssistantMessage(message) &&
      !piPlan.visibleMessageIndexes.has(index)
    ) {
      for (const id of extractAssistantToolCallIds(message)) {
        invalidToolCallIds.add(id);
      }
      droppedMessages.add(message);
      changed = true;
      continue;
    }

    if (isAssistantMessage(message)) {
      const toolCalls =
        piPlan.visibleToolCallPartsByMessageIndex.get(index) || [];
      for (const toolCall of toolCalls) {
        const id = String(toolCall?.id || "").trim();
        if (!id) continue;
        validToolCallIds.add(id);
        invalidToolCallIds.delete(id);
      }
      filtered.push(message);
      continue;
    }

    if (isToolResultMessage(message)) {
      const toolCallId = String(message?.toolCallId || "").trim();
      if (
        toolCallId &&
        (invalidToolCallIds.has(toolCallId) ||
          !validToolCallIds.has(toolCallId))
      ) {
        droppedMessages.add(message);
        changed = true;
        continue;
      }
    }

    filtered.push(message);
  }

  return {
    messages: changed ? filtered : input,
    changed,
    droppedMessages,
  };
}

function createProviderBoundPrunePlan(
  messages: any[],
  options: SessionPruningOptions = {},
) {
  const input = Array.isArray(messages) ? messages : [];
  const visible = createProviderVisibleMessagePlan(input);
  const protectedStart = findProtectedContextStart(
    visible.messages,
    normalizeProtectRecentTurns(options.protectRecentTurns),
  );
  const replacements = new Map<any, any>();
  let changed = visible.changed;
  const pruned = visible.messages.map((message, index) => {
    if (index >= protectedStart || !isToolResultMessage(message)) {
      return message;
    }
    if (isAlreadyOmitted(message?.content)) return message;
    const replacement = {
      ...message,
      content: omittedContentFor(message?.content),
    };
    replacements.set(message, replacement);
    changed = true;
    return replacement;
  });

  return {
    messages: changed ? pruned : input,
    changed,
    replacements,
    droppedMessages: visible.droppedMessages,
  };
}

export function dropProviderInvalidToolMessages(messages: any[]) {
  const input = Array.isArray(messages) ? messages : [];
  const plan = createProviderVisibleMessagePlan(input);
  return plan.changed ? plan.messages : input;
}

export function pruneSessionContextMessages(
  messages: any[],
  options: SessionPruningOptions = {},
) {
  return createProviderBoundPrunePlan(messages, options).messages;
}

export function mapMessagesToPrunedSessionContext(
  messages: any[],
  fullContextMessages: any[],
  options: SessionPruningOptions = {},
) {
  const list = Array.isArray(messages) ? messages : [];
  const fullList = Array.isArray(fullContextMessages)
    ? fullContextMessages
    : [];
  if (!list.length || !fullList.length) return list;

  const plan = createProviderBoundPrunePlan(fullList, options);
  if (!plan.changed) return list;

  let changed = false;
  const mapped: any[] = [];
  for (const message of list) {
    if (plan.droppedMessages.has(message)) {
      changed = true;
      continue;
    }
    if (plan.replacements.has(message)) {
      mapped.push(plan.replacements.get(message));
      changed = true;
      continue;
    }
    mapped.push(message);
  }

  return changed ? mapped : list;
}
