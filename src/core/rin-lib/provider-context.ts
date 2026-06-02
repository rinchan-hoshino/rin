import {
  mapMessagesToPrunedSessionContext,
  pruneSessionContextMessages,
} from "./session-pruning.js";

type ProviderBoundContextOptions = {
  protectRecentTurns?: number;
};

type EstimateContextTokens = (messages: any[]) => any;

export function buildProviderBoundContextMessages(
  messages: any[],
  options: ProviderBoundContextOptions = {},
) {
  return pruneSessionContextMessages(messages, options);
}

export function mapMessagesToProviderBoundContext(
  messages: any[],
  fullContextMessages: any[],
  options: ProviderBoundContextOptions = {},
) {
  return mapMessagesToPrunedSessionContext(
    messages,
    fullContextMessages,
    options,
  );
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

export function estimateProviderBoundContextTokens(
  messages: any[],
  estimateContextTokens: EstimateContextTokens | undefined,
  options: ProviderBoundContextOptions = {},
) {
  if (typeof estimateContextTokens !== "function") return 0;
  const providerMessages = buildProviderBoundContextMessages(
    messages || [],
    options,
  );
  return normalizeContextTokenEstimate(estimateContextTokens(providerMessages));
}
