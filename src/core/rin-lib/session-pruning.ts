import { extractToolCallParts } from "../message-content.js";
import { isPiCompactSkillReadCall } from "../pi/private-api.js";

export const RIN_SESSION_PRUNING_TOOL_CALL_BUCKET_SIZE = 16;
export const RIN_SESSION_PRUNING_RETAINED_TOOL_CALL_BUCKETS = 4;
export const RIN_SESSION_PRUNING_RETAINED_TOOL_CALL_ROUNDS = 8;
export const RIN_SESSION_PRUNING_PLACEHOLDER = "[pruned]";

export type ToolHistoryExchange = {
  toolName: string;
  toolCallId: string;
  callMessageIndex: number;
  callPartIndex: number;
  callOrdinal: number;
  call: any;
  resultMessageIndex: number;
  result: any;
};

export type ToolHistoryPolicyContext = {
  cwd: string;
  protectedToolCallStart: number;
};

export type ToolHistoryPolicy = {
  protectResult?: (
    exchange: ToolHistoryExchange,
    context: ToolHistoryPolicyContext,
  ) => boolean;
  compactResultContent?: (
    content: any,
    exchange: ToolHistoryExchange,
    context: ToolHistoryPolicyContext,
  ) => any;
};

export type SessionPruningOptions = {
  toolCallBucketSize?: number;
  retainedToolCallBuckets?: number;
  retainedToolCallRounds?: number;
  cwd?: string;
  toolHistoryPolicies?: Record<string, ToolHistoryPolicy>;
};

type ToolCallLocation = {
  toolName: string;
  toolCallId: string;
  messageIndex: number;
  partIndex: number;
  ordinal: number;
  part: any;
};

function normalizePositiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

export function normalizeToolCallBucketSize(value: unknown) {
  return normalizePositiveInteger(
    value,
    RIN_SESSION_PRUNING_TOOL_CALL_BUCKET_SIZE,
  );
}

export function normalizeRetainedToolCallBuckets(value: unknown) {
  return normalizePositiveInteger(
    value,
    RIN_SESSION_PRUNING_RETAINED_TOOL_CALL_BUCKETS,
  );
}

function normalizedToolName(value: unknown) {
  return String(value || "").trim();
}

function toolCallId(value: unknown) {
  return String(value || "").trim();
}

function isToolResultMessage(message: any) {
  const role = String(message?.role || "").trim();
  return role === "toolResult" || role === "tool_result";
}

function collectToolCalls(messages: any[]) {
  const calls = new Map<string, ToolCallLocation>();
  let count = 0;
  messages.forEach((message, messageIndex) => {
    if (String(message?.role || "").trim() !== "assistant") return;
    const parts = Array.isArray(message?.content) ? message.content : [];
    parts.forEach((part: any, partIndex: number) => {
      if (
        String(part?.type || "")
          .trim()
          .toLowerCase() !== "toolcall"
      ) {
        return;
      }
      const id = toolCallId(part?.id ?? part?.toolCallId);
      if (!id) return;
      if (!calls.has(id)) {
        calls.set(id, {
          toolName: normalizedToolName(part?.name ?? part?.toolName),
          toolCallId: id,
          messageIndex,
          partIndex,
          ordinal: count,
          part,
        });
      }
      count += 1;
    });
  });
  return { calls, count };
}

function collectToolExchanges(messages: any[]) {
  const { calls } = collectToolCalls(messages);
  const exchanges = new Map<string, ToolHistoryExchange>();
  messages.forEach((message, resultMessageIndex) => {
    if (!isToolResultMessage(message)) return;
    const id = toolCallId(message?.toolCallId);
    const call = calls.get(id);
    if (!id || !call || exchanges.has(id)) return;
    exchanges.set(id, {
      toolName:
        call.toolName || normalizedToolName(message?.toolName) || "unknown",
      toolCallId: id,
      callMessageIndex: call.messageIndex,
      callPartIndex: call.partIndex,
      callOrdinal: call.ordinal,
      call: call.part,
      resultMessageIndex,
      result: message,
    });
  });
  return exchanges;
}

function protectFailedResult(exchange: ToolHistoryExchange) {
  return Boolean(exchange.result?.isError);
}

const BUILTIN_TOOL_HISTORY_POLICIES: Record<string, ToolHistoryPolicy> = {
  read: {
    protectResult: (exchange, context) =>
      isPiCompactSkillReadCall(exchange.call?.arguments, context.cwd),
  },
  write: { protectResult: protectFailedResult },
  edit: { protectResult: protectFailedResult },
};

function resolveToolHistoryPolicy(
  toolName: string,
  overrides: Record<string, ToolHistoryPolicy> | undefined,
) {
  return {
    ...(BUILTIN_TOOL_HISTORY_POLICIES[toolName] || {}),
    ...(overrides?.[toolName] || {}),
  } satisfies ToolHistoryPolicy;
}

export function findProtectedToolCallRoundStart(
  messages: any[],
  retainedToolCallRounds: number,
) {
  const { calls, count } = collectToolCalls(messages);
  if (count === 0 || calls.size === 0) return 0;
  const retainedRounds = normalizePositiveInteger(
    retainedToolCallRounds,
    RIN_SESSION_PRUNING_RETAINED_TOOL_CALL_ROUNDS,
  );
  const locations = [...calls.values()].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  const roundMessageIndices = [
    ...new Set(locations.map((location) => location.messageIndex)),
  ];
  if (roundMessageIndices.length <= retainedRounds) return 0;
  const firstRetainedMessageIndex =
    roundMessageIndices[roundMessageIndices.length - retainedRounds];
  return (
    locations.find(
      (location) => location.messageIndex >= firstRetainedMessageIndex,
    )?.ordinal ?? count
  );
}

export function findProtectedToolCallBucketStart(
  messages: any[],
  toolCallBucketSize: number,
  retainedToolCallBuckets: number,
) {
  const toolCallCount = collectToolCalls(messages).count;
  if (toolCallCount === 0) return 0;
  const bucketSize = normalizeToolCallBucketSize(toolCallBucketSize);
  const retainedBucketCount = normalizeRetainedToolCallBuckets(
    retainedToolCallBuckets,
  );
  const currentBucketOrdinal = Math.floor(toolCallCount / bucketSize);
  const oldestRetainedBucketOrdinal = Math.max(
    0,
    currentBucketOrdinal - retainedBucketCount + 1,
  );
  return oldestRetainedBucketOrdinal * bucketSize;
}

function isAlreadyOmitted(content: any) {
  if (typeof content === "string") {
    return content === RIN_SESSION_PRUNING_PLACEHOLDER;
  }
  if (!Array.isArray(content) || content.length !== 1) return false;
  const item = content[0];
  return (
    item &&
    typeof item === "object" &&
    item.type === "text" &&
    item.text === RIN_SESSION_PRUNING_PLACEHOLDER
  );
}

function omittedContentFor(content: any) {
  if (Array.isArray(content)) {
    return [{ type: "text", text: RIN_SESSION_PRUNING_PLACEHOLDER }];
  }
  return RIN_SESSION_PRUNING_PLACEHOLDER;
}

function sameJsonValue(left: any, right: any) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function pruneSessionContextMessages(
  messages: any[],
  options: SessionPruningOptions = {},
) {
  const input = Array.isArray(messages) ? messages : [];
  const protectedToolCallStart =
    options.retainedToolCallRounds === undefined
      ? findProtectedToolCallBucketStart(
          input,
          normalizeToolCallBucketSize(options.toolCallBucketSize),
          normalizeRetainedToolCallBuckets(options.retainedToolCallBuckets),
        )
      : findProtectedToolCallRoundStart(input, options.retainedToolCallRounds);
  const context: ToolHistoryPolicyContext = {
    cwd: String(options.cwd || process.cwd()),
    protectedToolCallStart,
  };
  const exchanges = collectToolExchanges(input);
  const oldExchangeIds = new Set<string>();
  const resultContent = new Map<string, any>();
  const protectedResults = new Set<string>();

  for (const exchange of exchanges.values()) {
    if (exchange.callOrdinal >= protectedToolCallStart) continue;
    oldExchangeIds.add(exchange.toolCallId);
    const policy = resolveToolHistoryPolicy(
      exchange.toolName,
      options.toolHistoryPolicies,
    );
    const protectsResult = policy.protectResult?.(exchange, context) ?? false;
    if (protectsResult) protectedResults.add(exchange.toolCallId);
    if (!protectsResult && policy.compactResultContent) {
      const compacted = policy.compactResultContent(
        exchange.result?.content,
        exchange,
        context,
      );
      if (!sameJsonValue(compacted, exchange.result?.content)) {
        resultContent.set(exchange.toolCallId, compacted);
      }
    }
  }

  let changed = false;
  const pruned = input.map((message) => {
    if (!isToolResultMessage(message)) return message;
    const id = toolCallId(message?.toolCallId);
    if (!oldExchangeIds.has(id) || protectedResults.has(id)) return message;
    const customContent = resultContent.get(id);
    const content =
      customContent === undefined
        ? omittedContentFor(message?.content)
        : customContent;
    if (isAlreadyOmitted(message?.content) && customContent === undefined) {
      return message;
    }
    if (sameJsonValue(content, message?.content)) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? pruned : input;
}
