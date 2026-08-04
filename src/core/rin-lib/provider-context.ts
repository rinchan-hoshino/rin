import {
  pruneSessionContextMessages,
  type SessionPruningOptions,
} from "./session-pruning.js";

type ProviderBoundContextOptions = SessionPruningOptions;

type EstimateContextTokens = (messages: any[]) => any;

export function buildProviderBoundContextMessages(
  messages: any[],
  options: ProviderBoundContextOptions = {},
) {
  return pruneSessionContextMessages(messages, options);
}

export function buildProviderBoundContextEvent(
  event: any,
  options: ProviderBoundContextOptions = {},
) {
  if (!Array.isArray(event?.messages)) return undefined;
  const messages = buildProviderBoundContextMessages(event.messages, options);
  if (messages === event.messages) return undefined;
  return { messages };
}

export function normalizeContextTokenEstimate(estimate: any) {
  const tokens = Number(
    typeof estimate === "number" ? estimate : estimate?.tokens || 0,
  );
  return Number.isFinite(tokens) ? tokens : 0;
}

function readMessageTimestampMs(message: any) {
  const timestamp = message?.timestamp;
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp;
  }
  if (typeof timestamp === "string" && timestamp.trim()) {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function findLatestCompactionSummaryTimestamp(messages: any[]) {
  let latest = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (String(message?.role || "") !== "compactionSummary") continue;
    const timestamp = readMessageTimestampMs(message);
    if (timestamp && timestamp > latest) latest = timestamp;
  }
  return latest;
}

export function stripStaleAssistantUsageAfterCompaction(messages: any[]) {
  const latestCompactionTimestamp =
    findLatestCompactionSummaryTimestamp(messages);
  if (!latestCompactionTimestamp) return messages;
  let changed = false;
  const next = (Array.isArray(messages) ? messages : []).map((message) => {
    if (String(message?.role || "") !== "assistant") return message;
    if (!message?.usage) return message;
    const timestamp = readMessageTimestampMs(message);
    if (!timestamp || timestamp > latestCompactionTimestamp) return message;
    changed = true;
    const { usage: _usage, ...rest } = message;
    return rest;
  });
  return changed ? next : messages;
}

export function estimateProviderBoundContextTokens(
  messages: any[],
  estimateContextTokens: EstimateContextTokens | undefined,
  options: ProviderBoundContextOptions = {},
) {
  if (typeof estimateContextTokens !== "function") return 0;
  const providerMessages = buildProviderBoundContextMessages(
    stripStaleAssistantUsageAfterCompaction(messages),
    options,
  );
  return normalizeContextTokenEstimate(estimateContextTokens(providerMessages));
}
