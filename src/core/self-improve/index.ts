import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "../rin-lib/capability-types.js";
import { existsSync, readFileSync } from "fs";
import { isAssistantFinalMessage } from "../message-content.js";

import {
  enqueueMemoryMaintenanceJob,
  enqueueSessionSummaryJob,
  spawnQueuedMemoryWorker,
} from "./async-jobs.js";
import {
  formatSelfImproveAgentResult,
  formatSelfImproveResult,
} from "./lib.js";
import { readSessionMetadata } from "../session/metadata.js";

const DEFAULT_SELF_IMPROVE_REVIEW_EVERY_FINAL_MESSAGES = 8;
const reviewStateBySession = new Map<
  string,
  { finalMessages: number; lastQueuedMessage: number; initialized: boolean }
>();

function normalizeReviewEveryTurns(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed))
    return DEFAULT_SELF_IMPROVE_REVIEW_EVERY_FINAL_MESSAGES;
  const whole = Math.floor(parsed);
  return whole > 0 ? whole : DEFAULT_SELF_IMPROVE_REVIEW_EVERY_FINAL_MESSAGES;
}

export function readSelfImproveReviewEveryTurns(agentDir: string) {
  const root = String(agentDir || "").trim();
  if (!root) return DEFAULT_SELF_IMPROVE_REVIEW_EVERY_FINAL_MESSAGES;
  try {
    const settings = JSON.parse(readFileSync(`${root}/settings.json`, "utf8"));
    return normalizeReviewEveryTurns(settings?.selfImprove?.reviewEveryTurns);
  } catch {
    return DEFAULT_SELF_IMPROVE_REVIEW_EVERY_FINAL_MESSAGES;
  }
}

const sessionMeta = readSessionMetadata;

function shouldSkipAutomaticMaintenance(sessionFile: string) {
  return !existsSync(sessionFile);
}

function getSessionReviewState(sessionId: string) {
  const key = String(sessionId || "").trim();
  if (!key) return null;
  const current = reviewStateBySession.get(key) || {
    finalMessages: 0,
    lastQueuedMessage: 0,
    initialized: false,
  };
  reviewStateBySession.set(key, current);
  return current;
}

function normalizeEntryId(value: unknown) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function countFinalMessagesInSessionFile(sessionFile: string, leafId?: string) {
  const filePath = String(sessionFile || "").trim();
  if (!filePath || !existsSync(filePath)) return 0;
  try {
    const entries: any[] = [];
    const entryById = new Map<string, any>();
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = JSON.parse(trimmed);
      entries.push(entry);
      const id = normalizeEntryId(entry?.id);
      if (id) entryById.set(id, entry);
    }

    const targetId = normalizeEntryId(leafId);
    if (targetId && entryById.has(targetId)) {
      let count = 0;
      const visited = new Set<string>();
      let currentId: string | undefined = targetId;
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const entry = entryById.get(currentId);
        if (!entry) break;
        if (
          entry?.type === "message" &&
          isAssistantFinalMessage(entry.message)
        ) {
          count += 1;
        }
        currentId = normalizeEntryId(entry?.parentId);
      }
      return count;
    }

    return entries.filter(
      (entry) =>
        entry?.type === "message" && isAssistantFinalMessage(entry.message),
    ).length;
  } catch {
    return 0;
  }
}

function resolveFinalMessageCount(
  state: { finalMessages: number; lastQueuedMessage: number },
  meta: ReturnType<typeof sessionMeta>,
) {
  const persistedCount = countFinalMessagesInSessionFile(
    meta.sessionFile,
    meta.leafId,
  );
  if (persistedCount > 0) return persistedCount;
  return state.finalMessages + 1;
}

async function processSelfImproveReview(
  ctx: any,
  opts: {
    sessionFile?: string;
    leafId?: string;
    trigger: string;
    snapshotKey?: string;
  },
) {
  const sessionFile = String(opts.sessionFile || "").trim();
  const agentDir = String(ctx?.agentDir || "").trim();
  if (!sessionFile || !agentDir) {
    return;
  }
  if (shouldSkipAutomaticMaintenance(sessionFile)) {
    return;
  }
  const meta = readSessionMetadata(opts);
  await enqueueMemoryMaintenanceJob({
    agentDir,
    sessionFile,
    leafId: meta.leafId || undefined,
    trigger: opts.trigger,
    snapshotKey: opts.snapshotKey,
  });
  spawnQueuedMemoryWorker(agentDir);
}

async function processSessionSummaryUpdate(
  ctx: any,
  opts: { sessionFile?: string; leafId?: string; trigger: string },
) {
  const sessionFile = String(opts.sessionFile || "").trim();
  const agentDir = String(ctx?.agentDir || "").trim();
  if (!sessionFile || !agentDir) {
    return;
  }
  if (shouldSkipAutomaticMaintenance(sessionFile)) {
    return;
  }
  const meta = readSessionMetadata(opts);
  await enqueueSessionSummaryJob({
    agentDir,
    sessionFile,
    leafId: meta.leafId || undefined,
    trigger: opts.trigger,
  });
  spawnQueuedMemoryWorker(agentDir);
}

export default function selfImproveModule(
  options: RinCapabilityOptions,
): RinCapabilityDefinition {
  return {
    name: "self_improve",
    tools: [],
    hooks: {
      message_end: [
        async (event, ctx) => {
          const meta = sessionMeta(ctx);
          const state = getSessionReviewState(meta.sessionId);
          if (!state || !meta.sessionFile || !meta.sessionPersisted) return;
          if (!isAssistantFinalMessage(event?.message)) return;

          const interval = readSelfImproveReviewEveryTurns(
            String(ctx?.agentDir || ""),
          );
          const finalMessages = resolveFinalMessageCount(state, meta);
          state.finalMessages = Math.max(state.finalMessages, finalMessages);
          if (!state.initialized) {
            state.lastQueuedMessage =
              Math.floor(Math.max(0, state.finalMessages - 1) / interval) *
              interval;
            state.initialized = true;
          }
          if (state.finalMessages - state.lastQueuedMessage >= interval) {
            await processSelfImproveReview(ctx, {
              sessionFile: meta.sessionFile,
              leafId: meta.leafId,
              trigger: "self_improve:periodic_review",
              snapshotKey: `review:${state.finalMessages}`,
            });
            state.lastQueuedMessage = state.finalMessages;
          }
        },
      ],
      session_before_compact: [
        async (_event, ctx) => {
          const meta = sessionMeta(ctx);
          if (!meta.sessionFile || !meta.sessionPersisted) return;
          await processSelfImproveReview(ctx, {
            sessionFile: meta.sessionFile,
            leafId: meta.leafId,
            trigger: "self_improve:session_compaction_review",
            snapshotKey: `compact:${meta.leafId || meta.sessionFile}`,
          });
        },
      ],
      session_shutdown: [
        async (_event, ctx) => {
          const meta = sessionMeta(ctx);
          if (!meta.sessionPersisted) {
            if (meta.sessionId) reviewStateBySession.delete(meta.sessionId);
            return;
          }
          await processSessionSummaryUpdate(ctx, {
            sessionFile: meta.sessionFile,
            leafId: meta.leafId,
            trigger: "session_summary:session_shutdown",
          });
          if (meta.sessionId) reviewStateBySession.delete(meta.sessionId);
        },
      ],
    },
  };
}
