import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  calculateContextTokens as calculatePiContextTokens,
  estimateTokens as estimatePiMessageTokens,
} from "@earendil-works/pi-coding-agent";

import { estimateContextTokensWithHelpers } from "../rin-frontend-sdk/session-helpers.js";

function normalizeTokenCount(value: unknown) {
  const tokens = Number(value);
  return Number.isFinite(tokens) && tokens > 0 ? Math.ceil(tokens) : 0;
}

export function calculateContextTokens(usage: any) {
  if (!usage || typeof usage !== "object") return 0;
  try {
    return normalizeTokenCount(calculatePiContextTokens(usage));
  } catch {
    return 0;
  }
}

function normalizeMessageForPiTokenEstimate(message: any) {
  if (!message || typeof message !== "object") return undefined;
  if (message.role === "assistant" && typeof message.content === "string") {
    return { ...message, content: [{ type: "text", text: message.content }] };
  }
  return message;
}

export function estimateMessageTokens(message: any) {
  const normalized = normalizeMessageForPiTokenEstimate(message);
  if (!normalized) return 0;
  try {
    return normalizeTokenCount(estimatePiMessageTokens(normalized));
  } catch {
    return 0;
  }
}

export function estimateContextTokens(messages: AgentMessage[]) {
  return estimateContextTokensWithHelpers(messages, {
    calculateContextTokens,
    estimateMessageTokens,
  });
}
