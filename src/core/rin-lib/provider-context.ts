import {
  pruneSessionContextMessages,
  type SessionPruningOptions,
} from "./session-pruning.js";
import { formatPromptTimeContext } from "./prompt-context.js";

type ProviderBoundContextOptions = SessionPruningOptions;

type EstimateContextTokens = (messages: any[]) => any;

function addPromptTimeToUserMessages(messages: any[]) {
  let changed = false;
  const next = messages.map((message) => {
    if (String(message?.role || "").trim() !== "user") return message;
    const timestamp = readMessageTimestampMs(message);
    if (timestamp === undefined) return message;

    if (typeof message?.content === "string") {
      const content = formatPromptTimeContext(message.content, timestamp);
      if (content === message.content) return message;
      changed = true;
      return { ...message, content };
    }

    if (!Array.isArray(message?.content)) return message;
    const textIndex = message.content.findIndex(
      (part: any) => part?.type === "text" && typeof part?.text === "string",
    );
    if (textIndex < 0) {
      changed = true;
      return {
        ...message,
        content: [
          { type: "text", text: formatPromptTimeContext("", timestamp) },
          ...message.content,
        ],
      };
    }
    const part = message.content[textIndex];
    const text = formatPromptTimeContext(part.text, timestamp);
    if (text === part.text) return message;
    const content = message.content.slice();
    content[textIndex] = { ...part, text };
    changed = true;
    return { ...message, content };
  });
  return changed ? next : messages;
}

export function buildProviderBoundContextMessages(
  messages: any[],
  options: ProviderBoundContextOptions = {},
) {
  return addPromptTimeToUserMessages(
    pruneSessionContextMessages(messages, options),
  );
}

export function mapMessagesToProviderBoundContext(
  messages: any[],
  fullContextMessages: any[],
  options: ProviderBoundContextOptions = {},
) {
  if (!messages.length || !fullContextMessages.length) return messages;

  const providerContext = buildProviderBoundContextMessages(
    fullContextMessages,
    options,
  );
  if (providerContext === fullContextMessages) return messages;

  const replacements = new Map<any, any>();
  fullContextMessages.forEach((message, index) => {
    const replacement = providerContext[index];
    if (replacement !== message) replacements.set(message, replacement);
  });
  if (!replacements.size) return messages;

  let changed = false;
  const mapped = messages.map((message) => {
    const replacement = replacements.get(message);
    if (!replacement) return message;
    changed = true;
    return replacement;
  });
  return changed ? mapped : messages;
}

export function buildProviderBoundCompactionEvent(
  event: any,
  fullContextMessages: any[],
  options: ProviderBoundContextOptions = {},
) {
  const preparation = event?.preparation;
  if (!preparation) return event;
  return {
    ...event,
    preparation: {
      ...preparation,
      messagesToSummarize: mapMessagesToProviderBoundContext(
        preparation.messagesToSummarize || [],
        fullContextMessages,
        options,
      ),
      turnPrefixMessages: mapMessagesToProviderBoundContext(
        preparation.turnPrefixMessages || [],
        fullContextMessages,
        options,
      ),
    },
  };
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
