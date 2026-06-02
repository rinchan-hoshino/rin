import { asArray } from "../json-utils.js";
import { resolveTurnCompletion } from "../session/turn-result.js";
import { safeString } from "../text-utils.js";

export type RinTurnCompletionBaseline = {
  turnStartedAtMs: number;
  branchMessageCount: number;
};

export type RinTurnCompletionResolution = {
  messages: any[];
  completion: ReturnType<typeof resolveTurnCompletion>;
};

function callArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value;
}

function entryMessage(entry: any) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type !== "message") return null;
  return entry.message && typeof entry.message === "object"
    ? entry.message
    : null;
}

function readCurrentBranchMessages(session: any) {
  const context = session?.sessionManager?.buildSessionContext?.();
  if (Array.isArray(context?.messages)) return context.messages;
  return callArray(session?.sessionManager?.getBranch?.())
    .map(entryMessage)
    .filter(Boolean);
}

function messageTimestampMs(message: any) {
  const raw = message?.timestamp ?? message?.message?.timestamp;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(safeString(raw));
  return Number.isFinite(parsed) ? parsed : 0;
}

function isCurrentTurnMessage(message: any, turnStartedAtMs: number) {
  if (turnStartedAtMs <= 0) return true;
  const timestamp = messageTimestampMs(message);
  return timestamp <= 0 || timestamp >= turnStartedAtMs - 1000;
}

export function captureRinTurnCompletionBaseline(
  session: any,
  turnStartedAtMs = Date.now(),
): RinTurnCompletionBaseline {
  return {
    turnStartedAtMs,
    branchMessageCount: readCurrentBranchMessages(session).length,
  };
}

export function collectRinTurnCompletionMessages(
  session: any,
  options: {
    baseline: RinTurnCompletionBaseline;
  },
) {
  const branchMessages = readCurrentBranchMessages(session);
  const baselineCount = Math.max(
    0,
    Number(options.baseline.branchMessageCount),
  );
  const branchAdvanced = branchMessages.length >= baselineCount;
  const candidates = branchAdvanced
    ? branchMessages.slice(baselineCount)
    : branchMessages;
  return asArray<any>(candidates).filter((message) =>
    isCurrentTurnMessage(message, options.baseline.turnStartedAtMs),
  );
}

export function resolveRinTurnCompletionAfterPromptSettled(
  session: any,
  options: {
    baseline: RinTurnCompletionBaseline;
  },
): RinTurnCompletionResolution {
  const messages = collectRinTurnCompletionMessages(session, options);
  return {
    messages,
    completion: resolveTurnCompletion({ messages }),
  };
}

export function resolveRinTurnFailureMessage(session: any, messages: any[]) {
  const stateError = safeString(session?.agent?.state?.errorMessage).trim();
  if (stateError) return stateError;

  for (const message of [...messages].reverse()) {
    if (safeString(message?.role).trim() !== "assistant") continue;
    const errorMessage = safeString(message?.errorMessage).trim();
    if (errorMessage) return errorMessage;
  }
  return "";
}
