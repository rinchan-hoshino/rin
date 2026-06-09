import { asArray } from "../json-utils.js";
import { resolveTurnCompletion } from "../session/turn-result.js";
import { safeString } from "../text-utils.js";

export type RinTurnCompletionBaseline = {
  turnStartedAtMs: number;
  branchMessageCount: number;
  branchLeafId?: string | null;
  hasBranchLeafId: boolean;
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

function readCurrentBranchEntries(session: any) {
  return callArray(session?.sessionManager?.getBranch?.());
}

function readCurrentBranchMessages(session: any) {
  const context = session?.sessionManager?.buildSessionContext?.();
  if (Array.isArray(context?.messages)) return context.messages;
  return readCurrentBranchEntries(session).map(entryMessage).filter(Boolean);
}

function readCurrentBranchLeafId(session: any) {
  if (typeof session?.sessionManager?.getLeafId !== "function") {
    return { hasBranchLeafId: false, branchLeafId: undefined };
  }
  const leafId = session.sessionManager.getLeafId();
  return {
    hasBranchLeafId: true,
    branchLeafId: leafId === null ? null : safeString(leafId).trim(),
  };
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
  const leaf = readCurrentBranchLeafId(session);
  return {
    turnStartedAtMs,
    branchMessageCount: readCurrentBranchMessages(session).length,
    ...leaf,
  };
}

function collectRinTurnCompletionMessagesFromBranchEntries(
  session: any,
  baseline: RinTurnCompletionBaseline,
) {
  if (!baseline.hasBranchLeafId) return null;
  const branchEntries = readCurrentBranchEntries(session);
  if (!branchEntries.length) return null;

  let candidateEntries = branchEntries;
  if (baseline.branchLeafId) {
    const baselineIndex = branchEntries.findIndex(
      (entry) => safeString(entry?.id).trim() === baseline.branchLeafId,
    );
    candidateEntries =
      baselineIndex >= 0 ? branchEntries.slice(baselineIndex + 1) : [];
  }

  return candidateEntries
    .map(entryMessage)
    .filter(Boolean)
    .filter((message) =>
      isCurrentTurnMessage(message, baseline.turnStartedAtMs),
    );
}

export function collectRinTurnCompletionMessages(
  session: any,
  options: {
    baseline: RinTurnCompletionBaseline;
  },
) {
  const branchEntryMessages = collectRinTurnCompletionMessagesFromBranchEntries(
    session,
    options.baseline,
  );
  if (branchEntryMessages) return branchEntryMessages;

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

export function resolveRinLatestSubmittedTurnCompletion(
  session: any,
): RinTurnCompletionResolution {
  const branchMessages = readCurrentBranchMessages(session);
  const lastUserIndex = [...branchMessages]
    .reverse()
    .findIndex((message) => safeString(message?.role).trim() === "user");
  const submittedIndex =
    lastUserIndex >= 0 ? branchMessages.length - 1 - lastUserIndex : -1;
  const messages =
    submittedIndex >= 0 ? branchMessages.slice(submittedIndex + 1) : [];
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
