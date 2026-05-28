import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "../rin-lib/capability-types.js";
import { existsSync, readFileSync } from "fs";
import { isAssistantFinalMessage } from "../message-content.js";

import {
  enqueueMemoryMaintenanceJob,
  runMemoryMaintenanceJobNow,
  spawnQueuedMemoryWorker,
} from "./async-jobs.js";
import {
  formatSelfImproveAgentResult,
  formatSelfImproveResult,
} from "./lib.js";
import { readSessionMetadata } from "../session/metadata.js";
import { recordSelfImproveSkillReadEvent } from "./skill-usage.js";

const DEFAULT_SELF_IMPROVE_REVIEW_EVERY_FINAL_MESSAGES = 5;
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

type MemoryMaintenanceJobNowRunner = typeof runMemoryMaintenanceJobNow;

type SelfImproveModuleOptions = RinCapabilityOptions & {
  runMemoryMaintenanceJobNow?: MemoryMaintenanceJobNowRunner;
};

type SelfImproveReviewOptions = {
  sessionFile?: string;
  leafId?: string;
  trigger: string;
  snapshotKey?: string;
};

function resolveReviewJob(ctx: any, opts: SelfImproveReviewOptions) {
  const sessionFile = String(opts.sessionFile || "").trim();
  const agentDir = String(ctx?.agentDir || "").trim();
  if (!sessionFile || !agentDir) {
    return null;
  }
  if (shouldSkipAutomaticMaintenance(sessionFile)) {
    return null;
  }
  const meta = readSessionMetadata(opts);
  return {
    agentDir,
    sessionFile,
    leafId: meta.leafId || undefined,
    trigger: opts.trigger,
    snapshotKey: opts.snapshotKey,
  };
}

async function enqueueSelfImproveReview(
  ctx: any,
  opts: SelfImproveReviewOptions,
) {
  const job = resolveReviewJob(ctx, opts);
  if (!job) return;
  await enqueueMemoryMaintenanceJob(job);
  spawnQueuedMemoryWorker(job.agentDir);
}

async function processSelfImproveReviewNow(
  ctx: any,
  opts: SelfImproveReviewOptions,
  runner: MemoryMaintenanceJobNowRunner,
) {
  const job = resolveReviewJob(ctx, opts);
  if (!job) return;
  try {
    return await runner(job);
  } catch (error: any) {
    return {
      status: "failed",
      error: String(error?.message || error || "maintenance_job_failed"),
    };
  }
}

export default function selfImproveModule(
  options: RinCapabilityOptions,
): RinCapabilityDefinition {
  const runMemoryMaintenanceNow =
    (options as SelfImproveModuleOptions).runMemoryMaintenanceJobNow ||
    runMemoryMaintenanceJobNow;
  return {
    name: "self_improve",
    tools: [],
    hooks: {
      tool_execution_start: [recordSelfImproveSkillReadEvent],
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
            const reviewFinalMessages = state.finalMessages;
            state.lastQueuedMessage = reviewFinalMessages;
            await processSelfImproveReviewNow(
              ctx,
              {
                sessionFile: meta.sessionFile,
                leafId: meta.leafId,
                trigger: "self_improve:periodic_review",
                snapshotKey: `review:${reviewFinalMessages}`,
              },
              runMemoryMaintenanceNow,
            );
          }
        },
      ],
      session_shutdown: [
        async (event, ctx) => {
          if (String(event?.reason || "").trim() === "reload") return;
          const meta = sessionMeta(ctx);
          if (!meta.sessionPersisted) {
            if (meta.sessionId) reviewStateBySession.delete(meta.sessionId);
            return;
          }
          await enqueueSelfImproveReview(ctx, {
            sessionFile: meta.sessionFile,
            leafId: meta.leafId,
            trigger: "self_improve:session_shutdown_review",
          });
          if (meta.sessionId) reviewStateBySession.delete(meta.sessionId);
        },
      ],
    },
  };
}
