import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { asArray } from "../json-utils.js";
import { extractMessageText } from "../message-content.js";

export { computeAvailableThinkingLevels } from "../model-thinking-levels.js";

export function extractText(value: any): string {
  return extractMessageText(value, { includeThinking: true });
}

function getReusableUsage(
  message: any,
  calculateUsageTokens = calculateContextTokens,
) {
  if (message?.role !== "assistant") return undefined;
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const stopReason = String(message?.stopReason || "").trim();
  if (stopReason === "aborted" || stopReason === "error") return undefined;
  return calculateUsageTokens(usage) > 0 ? usage : undefined;
}

export function getLastAssistantText(messages: AgentMessage[]) {
  const list = asArray<AgentMessage>(messages);
  for (let i = list.length - 1; i >= 0; i--) {
    const message: any = list[i];
    if (message?.role !== "assistant") continue;
    const text = extractText(message.content);
    if (text) return text;
  }
  return undefined;
}

const ESTIMATED_IMAGE_CHARS = 4800;

type ContextTokenHelpers = {
  calculateContextTokens?: (usage: any) => number;
  estimateMessageTokens?: (message: any) => number;
};

function normalizeTokenCount(value: unknown) {
  const tokens = Number(value);
  return Number.isFinite(tokens) && tokens > 0 ? Math.ceil(tokens) : 0;
}

function contextTokenCount(value: unknown) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function calculateContextTokens(usage: any) {
  if (!usage || typeof usage !== "object") return 0;
  const explicit = contextTokenCount(usage.totalTokens);
  if (explicit) return explicit;
  return (
    contextTokenCount(usage.input) +
    contextTokenCount(usage.output) +
    contextTokenCount(usage.cacheRead) +
    contextTokenCount(usage.cacheWrite)
  );
}

function estimateTextAndImageContentChars(content: any) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return extractText(content).length;
  let chars = 0;
  for (const block of content) {
    if (block?.type === "text" && block.text) {
      chars += String(block.text).length;
    } else if (block?.type === "image") {
      chars += ESTIMATED_IMAGE_CHARS;
    }
  }
  return chars;
}

function estimateAssistantContentChars(content: any) {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return extractText(content).length;
  let chars = 0;
  for (const block of content) {
    if (block?.type === "text" && block.text) {
      chars += String(block.text).length;
    } else if (block?.type === "thinking" && block.thinking) {
      chars += String(block.thinking).length;
    } else if (block?.type === "toolCall") {
      chars +=
        String(block.name || "").length +
        String(JSON.stringify(block.arguments ?? {})).length;
    }
  }
  return chars;
}

export function estimateMessageTokens(message: any) {
  if (!message || typeof message !== "object") return 0;
  let chars = 0;
  switch (message.role) {
    case "user":
    case "custom":
    case "toolResult":
      chars = estimateTextAndImageContentChars(message.content);
      break;
    case "assistant":
      chars = estimateAssistantContentChars(message.content);
      break;
    case "bashExecution":
      chars =
        String(message.command || "").length +
        String(message.output || "").length;
      break;
    case "branchSummary":
    case "compactionSummary":
      chars = String(message.summary || "").length;
      break;
    default:
      chars = extractText(message.content).length;
      break;
  }
  return normalizeTokenCount(chars / 4);
}

export function estimateContextTokensWithHelpers(
  messages: AgentMessage[],
  helpers: ContextTokenHelpers = {},
) {
  const calculateUsageTokens =
    helpers.calculateContextTokens ?? calculateContextTokens;
  const estimateTokens = helpers.estimateMessageTokens ?? estimateMessageTokens;
  const list = asArray<AgentMessage>(messages);
  let trailingTokens = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const message: any = list[i];
    const usage = getReusableUsage(message, calculateUsageTokens);
    if (usage) return calculateUsageTokens(usage) + trailingTokens;
    trailingTokens += estimateTokens(message);
  }
  return trailingTokens;
}

export function estimateContextTokens(messages: AgentMessage[]) {
  return estimateContextTokensWithHelpers(messages);
}
