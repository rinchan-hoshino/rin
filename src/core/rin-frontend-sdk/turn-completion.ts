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

function readDurableEntries(session: any) {
  return callArray(session?.sessionManager?.getEntries?.());
}

function entryId(entry: any) {
  return safeString(entry?.id).trim();
}

function entryParentId(entry: any) {
  return safeString(entry?.parentId).trim();
}

function entryDescendsFrom(
  entry: any,
  ancestorId: string,
  entriesById: Map<string, any>,
) {
  const seen = new Set<string>();
  let current = entry;
  while (current && typeof current === "object") {
    const parentId = entryParentId(current);
    if (!parentId) return false;
    if (parentId === ancestorId) return true;
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    current = entriesById.get(parentId);
  }
  return false;
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

function collectMessagesFromEntriesAfterBaseline(
  entries: any[],
  baseline: RinTurnCompletionBaseline,
) {
  let candidateEntries = entries;
  if (baseline.branchLeafId) {
    const baselineIndex = entries.findIndex(
      (entry) => entryId(entry) === baseline.branchLeafId,
    );
    if (baselineIndex < 0) {
      // Auto-compaction can rewrite the durable branch while a turn is still
      // running, removing the pre-turn leaf that we captured as the structural
      // baseline. In that case, timestamp is the remaining safe durable
      // boundary: do not fall back to live branch/context snapshots, but do use
      // durable entries written after this turn began so the RPC terminal event
      // can still be produced for the already-generated final.
      return entries
        .map(entryMessage)
        .filter(Boolean)
        .filter((message) =>
          isCurrentTurnMessage(message, baseline.turnStartedAtMs),
        );
    }
    const entriesById = new Map<string, any>();
    for (const entry of entries) {
      const id = entryId(entry);
      if (id) entriesById.set(id, entry);
    }
    candidateEntries = entries
      .slice(baselineIndex + 1)
      .filter((entry) =>
        entryDescendsFrom(entry, baseline.branchLeafId || "", entriesById),
      );
  }

  return candidateEntries
    .map(entryMessage)
    .filter(Boolean)
    .filter((message) =>
      isCurrentTurnMessage(message, baseline.turnStartedAtMs),
    );
}

function collectRinTurnCompletionMessagesFromDurableEntries(
  session: any,
  baseline: RinTurnCompletionBaseline,
) {
  if (!baseline.hasBranchLeafId) return null;
  const durableEntries = readDurableEntries(session);
  if (!durableEntries.length) return null;
  return collectMessagesFromEntriesAfterBaseline(durableEntries, baseline);
}

export function collectRinTurnCompletionMessages(
  session: any,
  options: {
    baseline: RinTurnCompletionBaseline;
  },
) {
  return (
    collectRinTurnCompletionMessagesFromDurableEntries(
      session,
      options.baseline,
    ) || []
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

export function resolveRinTurnFailureMessage(
  session: any,
  messages: any[],
  options: { retryFailureMessage?: string } = {},
) {
  const retryFailureMessage = safeString(options.retryFailureMessage).trim();
  if (retryFailureMessage) return retryFailureMessage;

  const stateError = safeString(session?.agent?.state?.errorMessage).trim();
  if (stateError) return stateError;

  for (const message of [...messages].reverse()) {
    if (safeString(message?.role).trim() !== "assistant") continue;
    const errorMessage = safeString(message?.errorMessage).trim();
    if (errorMessage) return errorMessage;
  }
  return "";
}
