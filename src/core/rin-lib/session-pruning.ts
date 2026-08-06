import { extractToolCallParts } from "../message-content.js";
import { isPiCompactSkillReadCall } from "../pi/private-api.js";

export const RIN_SESSION_PRUNING_MESSAGE_BUCKET_SIZE = 32;
export const RIN_SESSION_PRUNING_RETAINED_BUCKETS = 4;
export const RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT =
  "old tool result omitted";
export type SessionSourceContext = {
  pruningBoundary: number;
  messageCount: number;
  nextPruningBoundary?: number;
};

export type SessionPruningOptions = {
  messageBucketSize?: number;
  retainedBuckets?: number;
  protectFromMessageIndex?: number;
  cwd?: string;
};

function normalizePositiveInteger(value: unknown, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

export function normalizeMessageBucketSize(value: unknown) {
  return normalizePositiveInteger(
    value,
    RIN_SESSION_PRUNING_MESSAGE_BUCKET_SIZE,
  );
}

export function normalizeRetainedMessageBuckets(value: unknown) {
  return normalizePositiveInteger(value, RIN_SESSION_PRUNING_RETAINED_BUCKETS);
}

export function normalizeProtectedMessageStart(value: unknown) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) return undefined;
  return index;
}

export function normalizeSessionSourceContext(
  value: unknown,
): SessionSourceContext | undefined {
  const context = value && typeof value === "object" ? (value as any) : {};
  const pruningBoundary = normalizeProtectedMessageStart(
    context.pruningBoundary,
  );
  const messageCount = Number(context.messageCount);
  const hasNextBoundary = context.nextPruningBoundary !== undefined;
  const nextPruningBoundary = hasNextBoundary
    ? normalizeProtectedMessageStart(context.nextPruningBoundary)
    : undefined;
  if (
    pruningBoundary === undefined ||
    !Number.isInteger(messageCount) ||
    messageCount <= 0 ||
    pruningBoundary >= messageCount ||
    (hasNextBoundary &&
      (nextPruningBoundary === undefined ||
        nextPruningBoundary <= pruningBoundary ||
        nextPruningBoundary >= messageCount))
  ) {
    return undefined;
  }
  return {
    pruningBoundary,
    messageCount,
    ...(nextPruningBoundary === undefined ? {} : { nextPruningBoundary }),
  };
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

export function findProtectedMessageBucketStart(
  messages: any[],
  messageBucketSize: number,
  retainedBuckets: number,
) {
  if (messages.length === 0) return 0;
  const bucketSize = normalizeMessageBucketSize(messageBucketSize);
  const retainedBucketCount = normalizeRetainedMessageBuckets(retainedBuckets);
  // Absolute indices make bucket ordinals stable within one provider-context
  // generation. The boundary advances only when a new bucket begins; it never
  // slides with the tail length. Compaction or branch replacement already
  // creates a new provider prefix and therefore a new generation.
  const currentBucketOrdinal = Math.floor((messages.length - 1) / bucketSize);
  const oldestRetainedBucketOrdinal = Math.max(
    0,
    currentBucketOrdinal - retainedBucketCount + 1,
  );
  return oldestRetainedBucketOrdinal * bucketSize;
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

export function pruneSessionContextMessages(
  messages: any[],
  options: SessionPruningOptions = {},
) {
  const input = Array.isArray(messages) ? messages : [];
  const bucketProtectedStart = findProtectedMessageBucketStart(
    input,
    normalizeMessageBucketSize(options.messageBucketSize),
    normalizeRetainedMessageBuckets(options.retainedBuckets),
  );
  const protectedStart = Math.min(
    bucketProtectedStart,
    normalizeProtectedMessageStart(options.protectFromMessageIndex) ??
      bucketProtectedStart,
  );
  const protectedToolResultIds = collectProtectedToolResultIds(
    input,
    String(options.cwd || process.cwd()),
  );
  let changed = false;
  const pruned = input.map((message, index) => {
    if (index >= protectedStart || !isToolResultMessage(message)) {
      return message;
    }
    if (
      isProtectedToolResult(message, protectedToolResultIds) ||
      isAlreadyOmitted(message?.content)
    ) {
      return message;
    }
    changed = true;
    return {
      ...message,
      content: omittedContentFor(message?.content),
    };
  });
  return changed ? pruned : input;
}
