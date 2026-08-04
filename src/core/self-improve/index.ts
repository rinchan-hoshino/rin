import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "../rin-lib/capability-types.js";
import { buildProviderBoundContextEvent } from "../rin-lib/provider-context.js";
import {
  enqueueSelfImproveMaintenanceJob,
  runSelfImproveMaintenanceJobNow as runSelfImproveMaintenanceJobNowDefault,
} from "./async-jobs.js";
import { readSessionMetadata } from "../session/metadata.js";
import { recordSelfImproveSkillReadEvent } from "./skill-usage.js";

const contextPruneReviewStateBySession = new Map<
  string,
  { lastAttemptedSnapshotKey?: string }
>();

const sessionMeta = readSessionMetadata;

function shouldSkipAutomaticMaintenance(sessionFile: string) {
  return !existsSync(sessionFile);
}

function contextPruneReviewStateKey(meta: ReturnType<typeof sessionMeta>) {
  return String(meta.sessionId || meta.sessionFile || "").trim();
}

function getContextPruneReviewState(meta: ReturnType<typeof sessionMeta>) {
  const key = contextPruneReviewStateKey(meta);
  if (!key) return null;
  const current = contextPruneReviewStateBySession.get(key) || {};
  contextPruneReviewStateBySession.set(key, current);
  return current;
}

function clearContextPruneReviewState(meta: ReturnType<typeof sessionMeta>) {
  const key = contextPruneReviewStateKey(meta);
  if (key) contextPruneReviewStateBySession.delete(key);
}

function contextPruneSnapshotKey(event: any, prunedEvent: any) {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const prunedMessages = Array.isArray(prunedEvent?.messages)
    ? prunedEvent.messages
    : [];
  const digest = createHash("sha256");
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index] === prunedMessages[index]) continue;
    digest.update(`${index}\0`);
    const serialized = JSON.stringify(messages[index]);
    digest.update(
      serialized === undefined ? String(messages[index]) : serialized,
    );
    digest.update("\0");
  }
  return `context-prune:${digest.digest("hex")}`;
}

function recordContextPruneReviewError(ctx: any, error: unknown) {
  try {
    ctx?.sessionManager?.appendCustomEntry?.("rin_core_capability_error", {
      event: "self_improve:context_prune_review",
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {}
}

const SELF_IMPROVE_FRONTEND_KINDS = new Set([
  "chat",
  "gui",
  "scheduled-task",
  "tui",
]);

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
  await enqueueSelfImproveMaintenanceJob(job);
  // The daemon owns queue workers so they cannot inherit this session worker's
  // short-lived isolation cgroup.
}

type SelfImproveModuleOptions = RinCapabilityOptions & {
  buildProviderBoundContextEvent?: typeof buildProviderBoundContextEvent;
  runSelfImproveMaintenanceJobNow?: typeof runSelfImproveMaintenanceJobNowDefault;
};

export default function selfImproveModule(
  options: SelfImproveModuleOptions,
): RinCapabilityDefinition {
  const detectProviderBoundContextPrune =
    options.buildProviderBoundContextEvent || buildProviderBoundContextEvent;
  const runSelfImproveMaintenanceJobNow =
    options.runSelfImproveMaintenanceJobNow ||
    runSelfImproveMaintenanceJobNowDefault;
  return {
    name: "self_improve",
    tools: [],
    hooks: {
      tool_execution_start: [recordSelfImproveSkillReadEvent],
      context: [
        async (event, ctx) => {
          try {
            if (!isUserFrontendSelfImproveTrigger(event, ctx)) return;
            const prunedEvent = detectProviderBoundContextPrune(event, {
              cwd: ctx.cwd,
            });
            if (!prunedEvent) return;
            const meta = sessionMeta(ctx);
            if (!meta.sessionFile || !meta.sessionPersisted) return;
            const state = getContextPruneReviewState(meta);
            const snapshotKey = contextPruneSnapshotKey(event, prunedEvent);
            if (!state || state.lastAttemptedSnapshotKey === snapshotKey)
              return;
            const job = resolveReviewJob(ctx, {
              sessionFile: meta.sessionFile,
              leafId: meta.leafId,
              trigger: "self_improve:context_prune_review",
              snapshotKey,
            });
            if (!job) return;
            state.lastAttemptedSnapshotKey = snapshotKey;
            await runSelfImproveMaintenanceJobNow(job);
          } catch (error) {
            recordContextPruneReviewError(ctx, error);
          }
        },
      ],
      session_shutdown: [
        async (event, ctx) => {
          if (String(event?.reason || "").trim() === "reload") return;
          const meta = sessionMeta(ctx);
          if (!isUserFrontendSelfImproveTrigger(event, ctx)) {
            clearContextPruneReviewState(meta);
            return;
          }
          if (!meta.sessionPersisted) {
            clearContextPruneReviewState(meta);
            return;
          }
          await enqueueSelfImproveReview(ctx, {
            sessionFile: meta.sessionFile,
            leafId: meta.leafId,
            trigger: "self_improve:session_shutdown_review",
          });
          clearContextPruneReviewState(meta);
        },
      ],
    },
  };
}
