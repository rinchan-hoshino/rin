import { existsSync } from "node:fs";

import { buildSessionContext } from "@earendil-works/pi-coding-agent";

import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "../rin-lib/capability-types.js";
import {
  findProtectedMessageBucketStart,
  RIN_SESSION_PRUNING_MESSAGE_BUCKET_SIZE,
  RIN_SESSION_PRUNING_RETAINED_BUCKETS,
  type SessionSourceContext,
} from "../rin-lib/session-pruning.js";
import { enqueueSelfImproveMaintenanceJob } from "./async-jobs.js";
import { readSessionMetadata } from "../session/metadata.js";
import { recordSelfImproveSkillReadEvent } from "./skill-usage.js";

const SELF_IMPROVE_FRONTEND_KINDS = new Set([
  "chat",
  "gui",
  "scheduled-task",
  "tui",
]);
const SELF_IMPROVE_ROLLOVER_TRIGGER = "self_improve:context_rollover_review";
const SELF_IMPROVE_SHUTDOWN_TRIGGER = "self_improve:session_shutdown_review";

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
  sourceContext?: SessionSourceContext;
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
    sourceContext: opts.sourceContext,
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

function providerGenerationKey(branch: any[], throughIndex: number) {
  for (let index = throughIndex; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "compaction" && entry?.type !== "branch_summary") {
      continue;
    }
    const id = normalizedText(entry?.id);
    if (id) return id;
  }
  return "root";
}

function calculatePruningBoundary(messages: any[]) {
  return findProtectedMessageBucketStart(
    messages,
    RIN_SESSION_PRUNING_MESSAGE_BUCKET_SIZE,
    RIN_SESSION_PRUNING_RETAINED_BUCKETS,
  );
}

type ProviderContextCheckpoint = {
  leafId: string;
  generationKey: string;
  pruningBoundary: number;
  messageCount: number;
};

function resolveProviderContextCheckpoint(branch: any[], entryIndex: number) {
  const leafId = normalizedText(branch[entryIndex]?.id);
  if (!leafId) return undefined;
  const messages = buildSessionContext(branch as any[], leafId).messages;
  return {
    leafId,
    generationKey: providerGenerationKey(branch, entryIndex),
    pruningBoundary: calculatePruningBoundary(messages),
    messageCount: messages.length,
  } satisfies ProviderContextCheckpoint;
}

function findPreviousProviderInputCheckpoint(
  branch: any[],
  currentLeafIndex: number,
) {
  for (let index = currentLeafIndex; index >= 0; index -= 1) {
    if (sessionEntryMessage(branch[index])?.role !== "assistant") continue;
    const parentId = normalizedText(branch[index]?.parentId);
    if (!parentId) return undefined;
    const parentIndex = branch.findIndex(
      (entry) => normalizedText(entry?.id) === parentId,
    );
    if (parentIndex < 0) return undefined;
    return resolveProviderContextCheckpoint(branch, parentIndex);
  }
  return undefined;
}

function resolvePrePruneContextReview(event: any, ctx: any) {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  if (messages.length === 0) return undefined;
  const branch = ctx?.sessionManager?.getBranch?.() || [];
  const leafId = normalizedText(ctx?.sessionManager?.getLeafId?.());
  const currentLeafIndex = branch.findIndex(
    (entry) => normalizedText(entry?.id) === leafId,
  );
  if (!leafId || currentLeafIndex < 0) return undefined;
  const generationKey = providerGenerationKey(branch, currentLeafIndex);
  const nextPruningBoundary = calculatePruningBoundary(messages);
  const previous = findPreviousProviderInputCheckpoint(
    branch,
    currentLeafIndex,
  );
  const pruningBoundary =
    previous?.generationKey === generationKey ? previous.pruningBoundary : 0;
  if (nextPruningBoundary <= pruningBoundary) return undefined;
  const sourceContext = {
    pruningBoundary,
    nextPruningBoundary,
    messageCount: messages.length,
  } satisfies SessionSourceContext;
  return {
    leafId,
    trigger: SELF_IMPROVE_ROLLOVER_TRIGGER,
    snapshotKey: `context-rollover:${generationKey}:${pruningBoundary}:${nextPruningBoundary}:${leafId}`,
    sourceContext,
  };
}

function resolveShutdownContextReview(branch: any[], requestedLeafId?: string) {
  const leafId =
    normalizedText(requestedLeafId) || normalizedText(branch.at(-1)?.id);
  if (!leafId) return undefined;
  const leafIndex = branch.findIndex(
    (entry) => normalizedText(entry?.id) === leafId,
  );
  if (leafIndex < 0) return undefined;
  const checkpoint = resolveProviderContextCheckpoint(branch, leafIndex);
  if (!checkpoint || checkpoint.messageCount <= 0) return undefined;
  const sourceContext = {
    pruningBoundary: checkpoint.pruningBoundary,
    messageCount: checkpoint.messageCount,
  } satisfies SessionSourceContext;
  return {
    leafId: checkpoint.leafId,
    trigger: SELF_IMPROVE_SHUTDOWN_TRIGGER,
    snapshotKey: `context-tail:${checkpoint.generationKey}:${sourceContext.pruningBoundary}:${sourceContext.messageCount}:${checkpoint.leafId}`,
    sourceContext,
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
  return {
    name: "self_improve",
    tools: [],
    hooks: {
      tool_execution_start: [recordSelfImproveSkillReadEvent],
      context: [
        async (event, ctx) => {
          if (!isUserFrontendSelfImproveTrigger(event, ctx)) return;
          const meta = readSessionMetadata(ctx);
          if (!meta.sessionFile || !meta.sessionPersisted) return;
          const prePruneReview = resolvePrePruneContextReview(event, ctx);
          if (!prePruneReview) return;
          await safelyEnqueueSelfImproveReview(enqueueJob, ctx, {
            sessionFile: meta.sessionFile,
            ...prePruneReview,
          });
          return undefined;
        },
      ],
      session_shutdown: [
        async (event, ctx) => {
          if (String(event?.reason || "").trim() === "reload") return;
          if (!isUserFrontendSelfImproveTrigger(event, ctx)) return;
          const meta = readSessionMetadata(ctx);
          if (!meta.sessionPersisted) return;
          const shutdownTail = resolveShutdownContextReview(
            ctx?.sessionManager?.getBranch?.() || [],
            meta.leafId,
          );
          if (!shutdownTail) return;
          await safelyEnqueueSelfImproveReview(enqueueJob, ctx, {
            sessionFile: meta.sessionFile,
            ...shutdownTail,
          });
        },
      ],
    },
  };
}
