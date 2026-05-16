import path from "node:path";

import { asArray } from "../json-utils.js";
import {
  extractExistingFilePaths,
  extractImageParts,
  extractMessageText,
} from "../message-content.js";
import { safeString } from "../text-utils.js";

export type TurnResultMessage =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      data: string;
      mimeType: string;
    }
  | {
      type: "file";
      path: string;
      name?: string;
    };

export type TurnResult = {
  messages: TurnResultMessage[];
};

export type TurnCompletionInput = {
  result?: TurnResult | null;
  messages?: any[];
  finalText?: unknown;
};

function trimTurnText(text: unknown): string {
  return safeString(text).trim();
}

function buildTextOnlyTurnResult(text: unknown): TurnResult {
  const value = trimTurnText(text);
  return value
    ? { messages: [{ type: "text", text: value }] }
    : { messages: [] };
}

function normalizeTurnMessages(
  messages: TurnResultMessage[] | null | undefined,
) {
  return asArray<TurnResultMessage>(messages).filter(Boolean);
}

function normalizeTurnResult(
  result: TurnResult | null | undefined,
): TurnResult | null {
  if (!Array.isArray(result?.messages)) return null;
  return { messages: normalizeTurnMessages(result.messages) };
}

function prependTurnText(result: TurnResult, text: string): TurnResult {
  return text
    ? {
        messages: [{ type: "text", text }, ...result.messages],
      }
    : result;
}

function resolveTextfulTurnResult(
  result: TurnResult | null | undefined,
): { result: TurnResult; finalText: string } | null {
  const normalized = normalizeTurnResult(result);
  if (!normalized) return null;
  const finalText = extractFinalTextFromTurnResult(normalized);
  return { result: normalized, finalText };
}

export function extractFinalTextFromTurnResult(
  result: TurnResult | null | undefined,
) {
  for (const message of normalizeTurnMessages(result?.messages)) {
    if (message.type !== "text") continue;
    const text = trimTurnText(message.text);
    if (text) return text;
  }
  return "";
}

export function resolveTurnResult(input: TurnCompletionInput = {}): TurnResult {
  const existingResult = resolveTextfulTurnResult(input.result);
  if (existingResult?.finalText) {
    return existingResult.result;
  }

  const normalizedExistingResult = normalizeTurnResult(input.result);
  const messagesResult = Array.isArray(input.messages)
    ? resolveTextfulTurnResult(buildTurnResultFromMessages(input.messages))
    : null;
  if (messagesResult?.finalText) {
    return messagesResult.result;
  }

  const fallbackText = trimTurnText(input.finalText);
  if (normalizedExistingResult) {
    return prependTurnText(normalizedExistingResult, fallbackText);
  }
  if (messagesResult) return messagesResult.result;
  return buildTextOnlyTurnResult(fallbackText);
}

export function resolveTurnCompletion(input: TurnCompletionInput = {}) {
  const result = resolveTurnResult(input);
  return {
    result,
    finalText: extractFinalTextFromTurnResult(result),
  };
}

function findLastAssistantMessage(messages: any[]) {
  for (const message of [...messages].reverse()) {
    if (safeString(message?.role) !== "assistant") continue;
    return message;
  }
  return null;
}

export function buildTurnResultFromMessages(messages: any[]): TurnResult {
  const assistant = findLastAssistantMessage(asArray(messages));
  if (!assistant) return { messages: [] };

  const text = extractMessageText(assistant.content, { trim: true });
  const images = extractImageParts(assistant.content);
  const files = extractExistingFilePaths(text);
  const result: TurnResultMessage[] = [];

  if (text) result.push({ type: "text", text });
  for (const image of images) {
    result.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  for (const filePath of files) {
    result.push({
      type: "file",
      path: filePath,
      name: path.basename(filePath),
    });
  }

  return { messages: result };
}
