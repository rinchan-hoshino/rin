import { resolveTurnCompletion } from "../session/turn-result.js";
import { safeString } from "../text-utils.js";

export type RinSubmittedTurnResolution =
  | { submitted: true }
  | {
      finalText: string;
      result?: unknown;
      sessionId?: string;
      sessionFile?: string;
    }
  | null;

function messageRole(message: unknown) {
  const value = message && typeof message === "object" ? (message as any) : {};
  return safeString(value?.message?.role || value?.role).trim();
}

function messageText(message: unknown) {
  const value = message && typeof message === "object" ? (message as any) : {};
  const content = value?.message?.content ?? value?.content;
  if (typeof content === "string") return safeString(content).trim();
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : safeString(part?.text || part?.content || part?.attrs?.content),
      )
      .join("")
      .trim();
  }
  return safeString(value?.text).trim();
}

function messageTimestampMs(message: unknown) {
  const value = message && typeof message === "object" ? (message as any) : {};
  const raw = value?.message?.timestamp ?? value?.timestamp;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(safeString(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function resolveSubmittedTurnFromMessages(
  messages: unknown[],
  input: { text: string; sentAt?: number },
): RinSubmittedTurnResolution {
  const sentAt = Number(input.sentAt || 0);
  if (!Number.isFinite(sentAt) || sentAt <= 0) return null;
  const promptText = safeString(input.text).trim();
  if (!promptText) return null;

  let submittedIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (messageRole(message) !== "user") continue;
    if (messageTimestampMs(message) < sentAt) continue;
    if (messageText(message) !== promptText) continue;
    submittedIndex = index;
    break;
  }
  if (submittedIndex < 0) return null;

  const completion = resolveTurnCompletion({
    messages: messages.slice(submittedIndex + 1),
  });
  const finalText = safeString(completion.finalText).trim();
  if (!finalText) return { submitted: true };
  return {
    finalText,
    result: completion.result,
  };
}
