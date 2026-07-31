import crypto from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Model } from "@earendil-works/pi-ai";

const HOME_DIR = os.homedir();

import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import { openBoundSession } from "../session/factory.js";
import { forkSessionManagerCompat } from "../session/fork.js";
import { readSessionMetadata } from "../session/metadata.js";
import { resolveAgentDir } from "./agent-dir.js";
import { safeString } from "./core/utils.js";
import { maintenanceLockPath } from "./paths.js";
import { buildSelfImproveReviewPrompt } from "./prompt.js";
import {
  beginSelfImproveAuditObservation,
  completeSelfImproveAuditObservation,
} from "./audit-observer.js";

export { buildSelfImproveReviewPrompt };

type ExtensionCtxLike = {
  model?: Model<any> | null;
};

async function createForkedSessionManager(options: {
  sessionFile: string;
  leafId?: string;
}) {
  const session = readSessionMetadata(options);
  const sessionFile = session.sessionFile
    ? path.resolve(session.sessionFile)
    : "";
  if (!sessionFile) throw new Error("session_file_required");
  const leafId = session.leafId || undefined;
  const { SessionManager } = await loadRinSessionManagerModule();
  const sourceManager = SessionManager.open(
    sessionFile,
    path.dirname(sessionFile),
  );
  const cwd = safeString(sourceManager.getCwd?.() || "").trim() || HOME_DIR;
  return {
    cwd,
    sessionManager: forkSessionManagerCompat(
      SessionManager as any,
      sessionFile,
      cwd,
      undefined,
      {
        persist: false,
        leafId,
        // Self-improve needs a temporary, non-persisted fork that behaves like
        // appending one distillation turn to the source conversation for
        // provider prefix-cache purposes. Keep the source session id as the
        // provider cache key while keeping distillation messages outside the
        // source transcript.
        preserveSourceSessionId: true,
        // Self-improve distillation forks are background turns. Routine
        // threshold-based compaction would add an extra model turn; keep
        // compaction for provider-error/context-overflow recovery.
        disableRoutineCompaction: true,
      },
    ),
  };
}

async function runForkedSessionPrompt(options: {
  agentDir: string;
  sessionFile: string;
  leafId?: string;
  prompt: string;
  additionalExtensionPaths?: string[];
}) {
  const fork = await createForkedSessionManager({
    sessionFile: options.sessionFile,
    leafId: options.leafId,
  });
  const { session, runtime } = await openBoundSession({
    cwd: fork.cwd,
    agentDir: options.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths,
    disabledRinCapabilities: ["self_improve"],
    sessionManager: fork.sessionManager,
    // Keep the source session's model options so provider prefix caching
    // matches a normal appended turn on the same conversation.
  });
  try {
    await session.prompt(options.prompt, {
      expandPromptTemplates: false,
      source: "builtin:self-improve",
    });
    await session.agent.waitForIdle();
    return safeString(session.getLastAssistantText?.() || "").trim();
  } finally {
    try {
      await session.abort();
    } catch {}
    try {
      await runtime.dispose();
    } catch {}
  }
}

async function assertUsableSessionFile(sessionFile: string) {
  try {
    const stat = await fs.stat(sessionFile);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error(`maintenance_job_invalid_session_file:${sessionFile}`);
    }
  } catch (error: any) {
    if (error?.message?.startsWith("maintenance_job_invalid_session_file:")) {
      throw error;
    }
    throw new Error(`maintenance_job_missing_session_file:${sessionFile}`);
  }
}

async function runForkedSessionSelfImproveReview(options: {
  agentDir: string;
  runId: string;
  startedAt: string;
  sessionFile: string;
  leafId?: string;
  snapshotKey?: string;
  trigger?: string;
  additionalExtensionPaths?: string[];
}) {
  const startedAudit = await beginSelfImproveAuditObservation({
    agentDir: options.agentDir,
    runId: options.runId,
    kind: "self_improve_review",
    startedAt: options.startedAt,
    source: {
      sessionFile: options.sessionFile,
      leafId: options.leafId,
      snapshotKey: options.snapshotKey,
      trigger: options.trigger,
    },
  });
  let finalText: string;
  try {
    await assertUsableSessionFile(options.sessionFile);
    finalText = await runForkedSessionPrompt({
      agentDir: options.agentDir,
      sessionFile: options.sessionFile,
      leafId: options.leafId,
      prompt: buildSelfImproveReviewPrompt(
        safeString(options.trigger).trim(),
        options.agentDir,
      ),
      additionalExtensionPaths: options.additionalExtensionPaths,
    });
  } catch (error) {
    const observed = await completeSelfImproveAuditObservation({
      agentDir: options.agentDir,
      handle: startedAudit.handle,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      auditError: startedAudit.auditError,
    });
    const failure =
      error && typeof error === "object" ? error : new Error(String(error));
    Object.assign(failure, {
      selfImproveAudit: observed.audit,
      selfImproveAuditHandle: observed.auditHandle,
      selfImproveAuditError: observed.auditError,
    });
    throw failure;
  }

  const observed = await completeSelfImproveAuditObservation({
    agentDir: options.agentDir,
    handle: startedAudit.handle,
    status: "completed",
    finishedAt: new Date().toISOString(),
    output: finalText,
    auditError: startedAudit.auditError,
  });
  return {
    skipped: "",
    forked: true,
    saved: true,
    output: finalText,
    changedFiles: observed.changedFiles,
    audit: observed.audit,
    auditHandle: observed.auditHandle,
    auditError: observed.auditError,
  };
}

async function assertMaintenanceLockHeld(agentDir: string, handle: FileHandle) {
  const [pathStat, handleStat] = await Promise.all([
    fs.stat(maintenanceLockPath(agentDir)),
    handle.stat(),
  ]);
  if (pathStat.dev !== handleStat.dev || pathStat.ino !== handleStat.ino) {
    throw new Error("self_improve_maintenance_lock_required");
  }
}

/** Internal mutation boundary; callers must keep the supplied lock held through history acknowledgment. */
export async function runMaintainerUnderMaintenanceLock(
  _ctx: ExtensionCtxLike & { sessionManager?: any },
  opts: {
    agentDir?: string;
    sessionFile?: string;
    leafId?: string;
    trigger?: string;
    additionalExtensionPaths?: string[];
    runId?: string;
    startedAt?: string;
    snapshotKey?: string;
    maintenanceLockHandle: FileHandle;
  },
) {
  const session = readSessionMetadata(opts);
  const sessionFile = session.sessionFile;
  if (!sessionFile) return { skipped: "no-session-file" };
  const trigger = safeString(opts.trigger || "self_improve:review").trim();
  const leafId = session.leafId || undefined;
  const agentDir = resolveAgentDir(opts.agentDir);
  await assertMaintenanceLockHeld(agentDir, opts.maintenanceLockHandle);
  const extracted = await runForkedSessionSelfImproveReview({
    agentDir,
    runId:
      safeString(opts.runId).trim() ||
      `self_improve_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    startedAt: safeString(opts.startedAt).trim() || new Date().toISOString(),
    sessionFile,
    leafId,
    snapshotKey: safeString(opts.snapshotKey).trim() || undefined,
    trigger,
    additionalExtensionPaths: opts.additionalExtensionPaths,
  });
  return {
    ...extracted,
    mode: "session",
    sessionFile,
    leafId,
    trigger,
  };
}
