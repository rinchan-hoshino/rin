import path from "node:path";

import { asArray } from "../json-utils.js";
import {
  extractAssistantFinalText,
  extractExistingFilePaths,
  extractImageParts,
} from "../message-content.js";
import { safeString } from "../text-utils.js";
import {
  classifyRinTurnMessage,
  findRinTerminalMessage,
} from "./turn-message.js";

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
  const normalizedExistingResult = normalizeTurnResult(input.result);
  if (normalizedExistingResult) return normalizedExistingResult;

  if (Array.isArray(input.messages)) {
    return buildTurnResultFromMessages(input.messages);
  }
  return buildTextOnlyTurnResult(input.finalText);
}

export function resolveTurnCompletion(input: TurnCompletionInput = {}) {
  const result = resolveTurnResult(input);
  return {
    result,
    finalText: extractFinalTextFromTurnResult(result),
  };
}

export function buildTurnResultFromMessages(messages: any[]): TurnResult {
  const assistant = findRinTerminalMessage(asArray(messages));
  if (!assistant || classifyRinTurnMessage(assistant) !== "complete") {
    return { messages: [] };
  }

  const text = extractAssistantFinalText(assistant);
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
