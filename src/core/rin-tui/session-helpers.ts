import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { asArray } from "../json-utils.js";
import { extractMessageText } from "../message-content.js";
import { calculateUsageTotalTokens } from "../usage-metrics.js";

export { computeAvailableThinkingLevels } from "../model-thinking-levels.js";

export function extractText(value: any): string {
  return extractMessageText(value, { includeThinking: true });
}

function getReusableUsage(message: any) {
  if (message?.role !== "assistant") return undefined;
  const usage = message?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const stopReason = String(message?.stopReason || "").trim();
  return stopReason === "aborted" || stopReason === "error" ? undefined : usage;
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

export function calculateContextTokens(usage: any) {
  if (!usage || typeof usage !== "object") return 0;
  return calculateUsageTotalTokens(usage);
}

function estimateTextTokens(text: string) {
  return text ? Math.ceil(text.length / 4) : 0;
}

export function estimateMessageTokens(message: any) {
  if (!message || typeof message !== "object") return 0;
  return estimateTextTokens(extractText(message?.content));
}

export function estimateContextTokens(messages: AgentMessage[]) {
  const list = asArray<AgentMessage>(messages);
  let trailingTokens = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const message: any = list[i];
    const usage = getReusableUsage(message);
    if (usage) return calculateContextTokens(usage) + trailingTokens;
    trailingTokens += estimateMessageTokens(message);
  }
  return trailingTokens;
}
