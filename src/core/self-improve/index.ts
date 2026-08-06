import { existsSync } from "node:fs";

import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "../rin-lib/capability-types.js";
import { isAssistantFinalMessage } from "../message-content.js";
import { normalizeSelfImproveTurnWindowTurns } from "./constants.js";
import { enqueueSelfImproveMaintenanceJob } from "./async-jobs.js";
import { readSessionMetadata } from "../session/metadata.js";
import { recordSelfImproveSkillReadEvent } from "./skill-usage.js";

const SELF_IMPROVE_FRONTEND_KINDS = new Set([
  "chat",
  "gui",
  "scheduled-task",
  "tui",
]);
const SELF_IMPROVE_WINDOW_TRIGGER = "self_improve:turn_window_review";

function shouldSkipAutomaticMaintenance(sessionFile: string) {
  return !existsSync(sessionFile);
}

function normalizedText(value: unknown) {
  return String(value ?? "").trim();
}

function resolveSelfImproveFrontend(event: unknown, ctx: any) {
  const source =
    (event as any)?.frontend ??
    ctx?.frontend ??
    ctx?.sessionManager?.__rinFrontend;
  const kind = normalizedText(source?.kind).toLowerCase();
  const key = normalizedText(source?.key ?? source?.id);
  return kind ? { kind, key } : undefined;
}

function resolvePromptContext(event: unknown, ctx: any) {
  return (
    (event as any)?.promptContext ??
    ctx?.promptContext ??
    ctx?.sessionManager?.__rinLastPromptContext
  );
}

function resolvePromptSource(event: unknown, ctx: any) {
  return normalizedText(
    (event as any)?.source ??
      ctx?.source ??
      ctx?.sessionManager?.__rinLastPromptSource,
  );
}

function isScheduledTaskPromptContext(promptContext: unknown) {
  const context = promptContext as any;
  return (
    normalizedText(context?.taskContextKind) === "scheduled-task" ||
    normalizedText(context?.source) === "scheduled-task"
  );
}

function isScheduledTaskProducer(event: unknown, ctx: any) {
  return (
    isScheduledTaskPromptContext(resolvePromptContext(event, ctx)) ||
    resolvePromptSource(event, ctx) === "scheduled-task"
  );
}

function hasSelfImproveEligibility(promptContext: unknown) {
  return Boolean((promptContext as any)?.selfImproveEligible === true);
}

function isUserFrontendSelfImproveTrigger(event: unknown, ctx: any) {
  const frontend = resolveSelfImproveFrontend(event, ctx);
  if (frontend?.kind === "chat" && !frontend.key) return false;
  if (frontend?.kind === "gui" || frontend?.kind === "tui") return true;
  const promptContext = resolvePromptContext(event, ctx);
  if (!hasSelfImproveEligibility(promptContext)) return false;
  if (frontend && SELF_IMPROVE_FRONTEND_KINDS.has(frontend.kind)) return true;
  return isScheduledTaskProducer(event, ctx);
}

type SelfImproveReviewOptions = {
  sessionFile?: string;
  leafId?: string;
  trigger: string;
  snapshotKey?: string;
};

type EnqueueMaintenanceJob = typeof enqueueSelfImproveMaintenanceJob;

function resolveReviewJob(ctx: any, opts: SelfImproveReviewOptions) {
  const sessionFile = String(opts.sessionFile || "").trim();
  const agentDir = String(ctx?.agentDir || "").trim();
  if (!sessionFile || !agentDir) return null;
  if (shouldSkipAutomaticMaintenance(sessionFile)) return null;
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
  enqueueJob: EnqueueMaintenanceJob,
  ctx: any,
  opts: SelfImproveReviewOptions,
) {
  const job = resolveReviewJob(ctx, opts);
  if (!job) return;
  await enqueueJob(job);
  // The daemon owns queue workers so they cannot inherit this session worker's
  // short-lived isolation cgroup.
}

async function safelyEnqueueSelfImproveReview(
  enqueueJob: EnqueueMaintenanceJob,
  ctx: any,
  opts: SelfImproveReviewOptions,
) {
  try {
    await enqueueSelfImproveReview(enqueueJob, ctx, opts);
  } catch {}
}

function sessionEntryMessage(entry: any) {
  return entry?.type === "message" ? entry.message : entry?.message || entry;
}

function countUserTurns(branch: any[]) {
  return branch.reduce((count, entry) => {
    return sessionEntryMessage(entry)?.role === "user" ? count + 1 : count;
  }, 0);
}

function sameFinalMessage(candidate: any, expected: any) {
  if (candidate === expected) return true;
  const candidateResponseId = normalizedText(candidate?.responseId);
  const expectedResponseId = normalizedText(expected?.responseId);
  if (candidateResponseId && expectedResponseId) {
    return candidateResponseId === expectedResponseId;
  }
  const candidateTimestamp = normalizedText(candidate?.timestamp);
  const expectedTimestamp = normalizedText(expected?.timestamp);
  if (!candidateTimestamp || candidateTimestamp !== expectedTimestamp) {
    return false;
  }
  return (
    normalizedText(candidate?.stopReason) ===
      normalizedText(expected?.stopReason) &&
    JSON.stringify(candidate?.content) === JSON.stringify(expected?.content)
  );
}

function findClosingAssistantIndex(branch: any[], closingMessage?: any) {
  if (closingMessage) {
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const message = sessionEntryMessage(branch[index]);
      if (
        isAssistantFinalMessage(message) &&
        sameFinalMessage(message, closingMessage)
      ) {
        return index;
      }
    }
    return -1;
  }
  let closingUserIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (sessionEntryMessage(branch[index])?.role !== "user") continue;
    closingUserIndex = index;
    break;
  }
  for (let index = closingUserIndex + 1; index < branch.length; index += 1) {
    if (isAssistantFinalMessage(sessionEntryMessage(branch[index]))) {
      return index;
    }
  }
  return -1;
}

function resolveCompletedTurnWindow(
  branch: any[],
  windowTurns: number,
  closingMessage?: any,
) {
  const closingAssistantIndex = findClosingAssistantIndex(
    branch,
    closingMessage,
  );
  if (closingAssistantIndex < 0) return undefined;
  const closingAssistantLeafId = normalizedText(
    branch[closingAssistantIndex]?.id,
  );
  if (!closingAssistantLeafId) return undefined;
  const userTurns = countUserTurns(branch.slice(0, closingAssistantIndex + 1));
  if (userTurns <= 0 || userTurns % windowTurns !== 0) return undefined;
  return {
    leafId: closingAssistantLeafId,
    trigger: SELF_IMPROVE_WINDOW_TRIGGER,
    snapshotKey: `turn-window:${windowTurns}:${userTurns}:${closingAssistantLeafId}`,
  };
}

type SelfImproveModuleOptions = RinCapabilityOptions & {
  enqueueSelfImproveMaintenanceJob?: EnqueueMaintenanceJob;
};

export default function selfImproveModule(
  options: SelfImproveModuleOptions,
): RinCapabilityDefinition {
  const enqueueJob =
    options.enqueueSelfImproveMaintenanceJob ||
    enqueueSelfImproveMaintenanceJob;
  const windowTurns = normalizeSelfImproveTurnWindowTurns(
    options.selfImproveTurnWindowTurns,
  );
  return {
    name: "self_improve",
    tools: [],
    hooks: {
      tool_execution_start: [recordSelfImproveSkillReadEvent],
      message_end: [
        async (event, ctx) => {
          if (!isUserFrontendSelfImproveTrigger(event, ctx)) return;
          if (!isAssistantFinalMessage(event?.message)) return;
          const meta = readSessionMetadata(ctx);
          if (!meta.sessionFile || !meta.sessionPersisted) return;
          const closingMessage = event.message;
          setImmediate(() => {
            try {
              const completedWindow = resolveCompletedTurnWindow(
                ctx?.sessionManager?.getBranch?.() || [],
                windowTurns,
                closingMessage,
              );
              if (!completedWindow) return;
              void safelyEnqueueSelfImproveReview(enqueueJob, ctx, {
                sessionFile: meta.sessionFile,
                ...completedWindow,
              });
            } catch {}
          });
        },
      ],
      session_shutdown: [
        async (event, ctx) => {
          if (String(event?.reason || "").trim() === "reload") return;
          if (!isUserFrontendSelfImproveTrigger(event, ctx)) return;
          const meta = readSessionMetadata(ctx);
          if (!meta.sessionPersisted) return;
          const completedWindow = resolveCompletedTurnWindow(
            ctx?.sessionManager?.getBranch?.() || [],
            windowTurns,
          );
          await safelyEnqueueSelfImproveReview(enqueueJob, ctx, {
            sessionFile: meta.sessionFile,
            ...(completedWindow || {
              leafId: meta.leafId,
              trigger: "self_improve:session_shutdown_review",
            }),
          });
        },
      ],
    },
  };
}
