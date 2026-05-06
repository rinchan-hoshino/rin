import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "../rin-lib/capability-types.js";
import { existsSync, readFileSync } from "fs";

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

const DEFAULT_SELF_IMPROVE_REVIEW_EVERY_TURNS = 5;
const reviewStateBySession = new Map<
  string,
  { userTurns: number; lastQueuedTurn: number }
>();

function normalizeReviewEveryTurns(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SELF_IMPROVE_REVIEW_EVERY_TURNS;
  const whole = Math.floor(parsed);
  return whole > 0 ? whole : DEFAULT_SELF_IMPROVE_REVIEW_EVERY_TURNS;
}

export function readSelfImproveReviewEveryTurns(agentDir: string) {
  const root = String(agentDir || "").trim();
  if (!root) return DEFAULT_SELF_IMPROVE_REVIEW_EVERY_TURNS;
  try {
    const settings = JSON.parse(readFileSync(`${root}/settings.json`, "utf8"));
    return normalizeReviewEveryTurns(
      settings?.selfImprove?.reviewEveryTurns ??
        settings?.selfImprove?.review?.everyTurns,
    );
  } catch {
    return DEFAULT_SELF_IMPROVE_REVIEW_EVERY_TURNS;
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
    userTurns: 0,
    lastQueuedTurn: 0,
  };
  reviewStateBySession.set(key, current);
  return current;
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
    tools: [],
    hooks: {
      message_end: [
        async (event, ctx) => {
          const role = String(event?.message?.role || "").trim();
          const meta = sessionMeta(ctx);
          const state = getSessionReviewState(meta.sessionId);
          if (!state || !meta.sessionFile || !meta.sessionPersisted) return;

          if (role === "user") {
            state.userTurns += 1;
            return;
          }

          if (
            role === "assistant" &&
            state.userTurns > 0 &&
            state.userTurns - state.lastQueuedTurn >=
              readSelfImproveReviewEveryTurns(String(ctx?.agentDir || ""))
          ) {
            await processSelfImproveReview(ctx, {
              sessionFile: meta.sessionFile,
              leafId: meta.leafId,
              trigger: "self_improve:periodic_review",
              snapshotKey: `review:${state.userTurns}`,
            });
            state.lastQueuedTurn = state.userTurns;
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
          await processSelfImproveReview(ctx, {
            sessionFile: meta.sessionFile,
            leafId: meta.leafId,
            trigger: "self_improve:session_shutdown_review",
          });
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
