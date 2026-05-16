import { asArray } from "../json-utils.js";
import { countToolCalls } from "../message-content.js";
import { readUsageMetrics } from "../usage-metrics.js";
import {
  calculateContextTokens,
  estimateContextTokens,
} from "./session-helpers.js";

export function getContextUsage(model: any, messages: any[], branch: any[]) {
  const contextWindow = Number(model?.contextWindow || 0);
  if (contextWindow <= 0) return undefined;

  const nextMessages = asArray<any>(messages);
  const nextBranch = asArray<any>(branch);

  let latestCompactionIndex = -1;
  for (let i = nextBranch.length - 1; i >= 0; i--) {
    if (nextBranch[i]?.type === "compaction") {
      latestCompactionIndex = i;
      break;
    }
  }

  if (latestCompactionIndex >= 0) {
    let hasPostCompactionUsage = false;
    for (let i = nextBranch.length - 1; i > latestCompactionIndex; i--) {
      const entry = nextBranch[i];
      const message: any = entry?.type === "message" ? entry.message : null;
      const usage = message?.role === "assistant" ? message?.usage : undefined;
      const stopReason = String(message?.stopReason || "");
      if (usage && stopReason !== "aborted" && stopReason !== "error") {
        if (calculateContextTokens(usage) > 0) hasPostCompactionUsage = true;
        break;
      }
    }
    if (!hasPostCompactionUsage) {
      return { tokens: null, contextWindow, percent: null };
    }
  }

  const tokens = Number(estimateContextTokens(nextMessages) || 0);
  return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
}

export function computeSessionStats(
  model: any,
  sessionFile: string | undefined,
  sessionId: string,
  entries: any[],
  contextUsage: any,
) {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;

  for (const entry of asArray<any>(entries)) {
    if (entry?.type !== "message" || !entry.message) continue;
    const message = entry.message;
    if (message.role === "user") userMessages += 1;
    if (message.role === "assistant") {
      assistantMessages += 1;
      const usageMetrics = readUsageMetrics((message as any).usage);
      input += usageMetrics.input;
      output += usageMetrics.output;
      cacheRead += usageMetrics.cacheRead;
      cacheWrite += usageMetrics.cacheWrite;
      cost += usageMetrics.costTotal;
      toolCalls += countToolCalls((message as any).content);
    }
    if (message.role === "toolResult") toolResults += 1;
  }

  const totalTokens = input + output + cacheRead + cacheWrite;
  return {
    sessionFile,
    sessionId,
    userMessages,
    assistantMessages,
    toolCalls,
    toolResults,
    totalMessages: userMessages + assistantMessages + toolResults,
    tokens: { input, output, cacheRead, cacheWrite, total: totalTokens },
    cost,
    contextUsage,
  };
}
