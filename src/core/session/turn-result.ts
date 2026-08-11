import { asArray } from "../json-utils.js";
import {
  extractAssistantFinalText,
  extractImageParts,
  extractMessageText,
  isAssistantFailedMessage,
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

export function buildTurnResultFromAssistantMessage(
  assistant: any,
  options: { allowToolCalls?: boolean } = {},
): TurnResult {
  if (
    safeString(assistant?.role).trim() !== "assistant" ||
    isAssistantFailedMessage(assistant)
  ) {
    return { messages: [] };
  }

  const text = options.allowToolCalls
    ? safeString(
        extractMessageText(assistant.content, {
          includeThinking: false,
          trim: true,
        }),
      ).trim()
    : extractAssistantFinalText(assistant);
  const images = extractImageParts(assistant.content);
  const result: TurnResultMessage[] = [];

  if (text) result.push({ type: "text", text });
  for (const image of images) {
    result.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }

  return { messages: result };
}

export function buildTurnResultFromMessages(messages: any[]): TurnResult {
  const assistant = findRinTerminalMessage(asArray(messages));
  if (!assistant || classifyRinTurnMessage(assistant) !== "complete") {
    return { messages: [] };
  }
  return buildTurnResultFromAssistantMessage(assistant);
}
