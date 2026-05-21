import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { maintainMemory } from "./maintainer.js";
import { asArray } from "../json-utils.js";
import {
  appendJsonLine,
  readJsonFile,
  stringifyJson,
  writeJsonAtomic,
} from "../platform/fs.js";
import { sleep } from "../platform/process.js";
import { normalizeSessionValue } from "../session/ref.js";
import { nowIso, safeString, uniqueStrings } from "./core/utils.js";
import {
  maintenanceHistoryPath,
  maintenanceLockPath,
  maintenanceQueuePath,
  selfImproveStateDir,
} from "./paths.js";

const PENDING_NOTICES_FILE = "pending-notices.json";

export type MaintenanceJob = {
  id: string;
  kind: "self_improve_review";
  createdAt: string;
  updatedAt: string;
  agentDir: string;
  sessionFile: string;
  leafId?: string;
  trigger: string;
  snapshotKey?: string;
  additionalExtensionPaths?: string[];
  attempts?: number;
  lastError?: string;
  lastAttemptAt?: string;
};

type MaintenanceChangedFile = {
  path: string;
  change: "created" | "updated" | "deleted";
};

export type MemoryMaintenanceNotice = {
  type: "self_improve_review_notice";
  status: "queued" | "completed" | "failed" | "skipped";
  skipped?: string;
  targets?: string[];
  hiddenTargetCount?: number;
  changedCount?: number;
};

export type PendingMemoryMaintenanceNotice = {
  id: string;
  createdAt: string;
  updatedAt: string;
  agentDir: string;
  sessionFile: string;
  notice: MemoryMaintenanceNotice;
};

type MaintenanceHistoryRecord = {
  id: string;
  kind: MaintenanceJob["kind"];
  status: "completed" | "failed";
  trigger: string;
  sessionFile: string;
  leafId?: string;
  snapshotKey?: string;
  startedAt: string;
  finishedAt: string;
  attempts: number;
  skipped?: string;
  error?: string;
  outputPreview?: string;
  changedFiles?: MaintenanceChangedFile[];
};

function resolveAgentDir(value: unknown) {
  const normalized = normalizeSessionValue(value);
  return normalized ? path.resolve(normalized) : "";
}

function resolveSessionFile(value: unknown) {
  const normalized = normalizeSessionValue(value);
  return normalized ? path.resolve(normalized) : "";
}

function normalizeAdditionalExtensionPaths(value: unknown) {
  const normalized = uniqueStrings(
    asArray(value)
      .map((item) => safeString(item).trim())
      .filter(Boolean),
  );
  return normalized.length ? normalized : undefined;
}

async function ensureStateDir(agentDir: string) {
  await fs.mkdir(selfImproveStateDir(agentDir), { recursive: true });
}

function pendingNoticesPath(agentDir: string) {
  return path.join(selfImproveStateDir(agentDir), PENDING_NOTICES_FILE);
}

function loadPendingNotices(
  agentDir: string,
): PendingMemoryMaintenanceNotice[] {
  const root = resolveAgentDir(agentDir);
  if (!root) return [];
  const parsed = readJsonFile<unknown>(pendingNoticesPath(root), []);
  return asArray<PendingMemoryMaintenanceNotice>(parsed).filter(
    (item) =>
      item &&
      typeof item === "object" &&
      safeString((item as any).sessionFile).trim() &&
      safeString((item as any).notice?.type).trim() ===
        "self_improve_review_notice",
  );
}

async function savePendingNotices(
  agentDir: string,
  notices: PendingMemoryMaintenanceNotice[],
) {
  await ensureStateDir(agentDir);
  writeJsonAtomic(pendingNoticesPath(agentDir), notices);
}

export async function appendPendingMemoryMaintenanceNotice(input: {
  agentDir: string;
  sessionFile: string;
  notice: MemoryMaintenanceNotice;
}) {
  const agentDir = resolveAgentDir(input.agentDir);
  const sessionFile = resolveSessionFile(input.sessionFile);
  if (!agentDir || !sessionFile) return;
  const now = nowIso();
  const notices = loadPendingNotices(agentDir);
  notices.push({
    id: `maintenance_notice_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    updatedAt: now,
    agentDir,
    sessionFile,
    notice: input.notice,
  });
  await savePendingNotices(agentDir, notices);
}

export async function takePendingMemoryMaintenanceNotices(input: {
  agentDir: string;
  sessionFile?: string;
}) {
  const agentDir = resolveAgentDir(input.agentDir);
  if (!agentDir) return [];
  const sessionFile = resolveSessionFile(input.sessionFile);
  const notices = loadPendingNotices(agentDir);
  const taken: PendingMemoryMaintenanceNotice[] = [];
  const remaining: PendingMemoryMaintenanceNotice[] = [];
  for (const notice of notices) {
    if (
      !sessionFile ||
      resolveSessionFile(notice.sessionFile) === sessionFile
    ) {
      taken.push(notice);
    } else {
      remaining.push(notice);
    }
  }
  if (taken.length) await savePendingNotices(agentDir, remaining);
  return taken.map((entry) => entry.notice);
}

async function loadQueue(agentDir: string): Promise<MaintenanceJob[]> {
  const parsed = readJsonFile<unknown>(maintenanceQueuePath(agentDir), []);
  return asArray<MaintenanceJob>(parsed).filter(
    (item) =>
      item &&
      typeof item === "object" &&
      safeString((item as any).kind).trim() !== "session_summary",
  );
}

async function saveQueue(agentDir: string, jobs: MaintenanceJob[]) {
  await ensureStateDir(agentDir);
  writeJsonAtomic(maintenanceQueuePath(agentDir), jobs);
}

function sameJob(a: Partial<MaintenanceJob>, b: Partial<MaintenanceJob>) {
  const sameBase =
    safeString(a.kind).trim() === safeString(b.kind).trim() &&
    safeString(a.agentDir).trim() === safeString(b.agentDir).trim() &&
    safeString(a.sessionFile).trim() === safeString(b.sessionFile).trim();
  if (!sameBase) return false;
  const aSnapshotKey = safeString(a.snapshotKey).trim();
  const bSnapshotKey = safeString(b.snapshotKey).trim();
  if (aSnapshotKey || bSnapshotKey) {
    return aSnapshotKey === bSnapshotKey;
  }
  return true;
}

function defaultTrigger(_kind: MaintenanceJob["kind"]) {
  return "self_improve:review";
}

function createMaintenanceJob(
  input: Omit<MaintenanceJob, "id" | "createdAt" | "updatedAt">,
): MaintenanceJob {
  const agentDir = resolveAgentDir(input.agentDir);
  const sessionFile = resolveSessionFile(input.sessionFile);
  const kind: MaintenanceJob["kind"] = "self_improve_review";
  const trigger = safeString(input.trigger).trim() || defaultTrigger(kind);
  const snapshotKey = safeString(input.snapshotKey).trim();
  const leafId = safeString(input.leafId).trim();
  if (!agentDir || !sessionFile) {
    throw new Error("maintenance_job_invalid_input");
  }

  const updatedAt = nowIso();
  return {
    id: `maintenance_job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    kind,
    createdAt: updatedAt,
    updatedAt,
    agentDir,
    sessionFile,
    leafId: leafId || undefined,
    trigger,
    snapshotKey: snapshotKey || undefined,
    additionalExtensionPaths: normalizeAdditionalExtensionPaths(
      input.additionalExtensionPaths,
    ),
  };
}

async function enqueueMaintenanceJob(
  input: Omit<MaintenanceJob, "id" | "createdAt" | "updatedAt">,
) {
  const nextJob = createMaintenanceJob(input);
  const jobs = await loadQueue(nextJob.agentDir);
  const existing = jobs.find((job) => sameJob(job, nextJob));
  if (existing) {
    existing.updatedAt = nextJob.updatedAt;
    existing.kind = nextJob.kind;
    existing.trigger = nextJob.trigger;
    existing.leafId = nextJob.leafId;
    existing.snapshotKey = nextJob.snapshotKey;
    existing.additionalExtensionPaths = nextJob.additionalExtensionPaths;
    existing.attempts = undefined;
    existing.lastError = undefined;
    existing.lastAttemptAt = undefined;
  } else {
    jobs.push(nextJob);
  }
  await saveQueue(nextJob.agentDir, jobs);
}

export async function enqueueMemoryMaintenanceJob(
  input: Omit<MaintenanceJob, "id" | "createdAt" | "updatedAt" | "kind">,
) {
  await enqueueMaintenanceJob({
    ...input,
    kind: "self_improve_review",
  });
}

const WORKER_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

function processExists(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockIsExpired(createdAt: unknown, nowMs = Date.now()) {
  const timestamp = Date.parse(safeString(createdAt).trim());
  if (!Number.isFinite(timestamp)) return true;
  return nowMs - timestamp > WORKER_LOCK_STALE_MS;
}

async function acquireWorkerLock(agentDir: string) {
  await ensureStateDir(agentDir);
  const filePath = maintenanceLockPath(agentDir);
  try {
    const handle = await fs.open(filePath, "wx");
    await handle.writeFile(
      stringifyJson({ pid: process.pid, createdAt: nowIso() }),
      "utf8",
    );
    return handle;
  } catch (error: any) {
    if (error?.code !== "EEXIST") return null;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      const pid = Number(parsed?.pid || 0);
      if (!processExists(pid) || lockIsExpired(parsed?.createdAt)) {
        await fs.rm(filePath, { force: true });
        const handle = await fs.open(filePath, "wx");
        await handle.writeFile(
          stringifyJson({ pid: process.pid, createdAt: nowIso() }),
          "utf8",
        );
        return handle;
      }
    } catch {}
    return null;
  }
}

async function releaseWorkerLock(
  agentDir: string,
  handle: fs.FileHandle | null,
) {
  try {
    await handle?.close();
  } catch {}
  try {
    await fs.rm(maintenanceLockPath(agentDir), { force: true });
  } catch {}
}

async function acquireWorkerLockWithWait(
  agentDir: string,
  timeoutMs = 30 * 60 * 1000,
) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    const handle = await acquireWorkerLock(agentDir);
    if (handle) return handle;
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

async function removeMatchingJobs(agentDir: string, target: MaintenanceJob) {
  const jobs = await loadQueue(agentDir);
  const remaining = jobs.filter((job) => !sameJob(job, target));
  if (remaining.length === jobs.length) return;
  await saveQueue(agentDir, remaining);
}

function normalizeChangedFiles(value: unknown): MaintenanceChangedFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      path: safeString((item as any)?.path).trim(),
      change: safeString((item as any)?.change).trim(),
    }))
    .filter((item) => item.path)
    .map((item) => ({
      path: item.path,
      change:
        item.change === "created" ||
        item.change === "updated" ||
        item.change === "deleted"
          ? item.change
          : "updated",
    }));
}

function truncateText(value: unknown, limit = 800) {
  const text = safeString(value).trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function selfImproveRelativePath(filePath: string) {
  const normalized = safeString(filePath).replace(/\\/g, "/");
  const marker = "/self_improve/";
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex + marker.length);
  if (normalized.startsWith("self_improve/")) {
    return normalized.slice("self_improve/".length);
  }
  return normalized;
}

function stripMarkdownExtension(value: string) {
  return value.replace(/\.(?:md|markdown)$/i, "");
}

function shortTargetName(value: string, maxLength = 42) {
  const target = stripMarkdownExtension(safeString(value).trim());
  if (!target) return "";
  return target.length > maxLength
    ? `${target.slice(0, Math.max(1, maxLength - 1))}…`
    : target;
}

function changedFileTarget(filePath: string) {
  const relative = selfImproveRelativePath(filePath);
  const parts = relative.split("/").filter(Boolean);
  if (parts[0] === "prompts" && parts[1]) return shortTargetName(parts[1]);
  if (parts[0] === "skills" && parts[1]) {
    if (parts[1] === "memory-index" && parts.includes("transactions")) {
      return shortTargetName(parts.at(-1) || parts[1]);
    }
    return shortTargetName(parts[1]);
  }
  return shortTargetName(parts.at(-1) || relative, 32);
}

function summarizeChangedTargets(changedFiles: MaintenanceChangedFile[]) {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const file of changedFiles) {
    const target = changedFileTarget(file.path);
    if (!target || seen.has(target)) continue;
    seen.add(target);
    targets.push(target);
  }
  const visible = targets.slice(0, 3);
  return {
    targets: visible,
    hiddenTargetCount: Math.max(0, targets.length - visible.length),
  };
}

function normalizeErrorMessage(error: unknown) {
  return safeString(
    (error as any)?.message || error || "maintenance_job_failed",
  ).trim();
}

export function buildMemoryMaintenanceNotice(input: {
  status?: string;
  changedFiles?: unknown;
  changedCount?: number;
  skipped?: string;
}): MemoryMaintenanceNotice {
  const status = safeString(input.status).trim();
  const skipped = safeString(input.skipped).trim();
  if (status === "queued") {
    return { type: "self_improve_review_notice", status: "queued" };
  }
  if (status === "failed") {
    return { type: "self_improve_review_notice", status: "failed" };
  }
  if (status === "skipped" || skipped) {
    return {
      type: "self_improve_review_notice",
      status: "skipped",
      skipped: skipped || undefined,
    };
  }
  const changedFiles = normalizeChangedFiles(input.changedFiles);
  const summary = summarizeChangedTargets(changedFiles);
  const changedCount = Number.isFinite(input.changedCount)
    ? Math.max(0, Math.floor(Number(input.changedCount)))
    : changedFiles.length;
  return {
    type: "self_improve_review_notice",
    status: "completed",
    targets: summary.targets,
    ...(summary.hiddenTargetCount
      ? { hiddenTargetCount: summary.hiddenTargetCount }
      : {}),
    changedCount,
  };
}

async function appendHistoryRecord(
  agentDir: string,
  record: MaintenanceHistoryRecord,
) {
  await appendJsonLine(maintenanceHistoryPath(agentDir), record);
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

async function processJob(job: MaintenanceJob) {
  const agentDir = resolveAgentDir(job.agentDir);
  const sessionFile = resolveSessionFile(job.sessionFile);
  const leafId = safeString(job.leafId).trim() || undefined;
  if (!agentDir || !sessionFile) {
    throw new Error("maintenance_job_invalid_payload");
  }
  await assertUsableSessionFile(sessionFile);
  return await maintainMemory({} as any, {
    agentDir,
    sessionFile,
    leafId,
    trigger: job.trigger,
    additionalExtensionPaths: job.additionalExtensionPaths,
  });
}

export async function runMemoryMaintenanceJobNow(
  input: Omit<MaintenanceJob, "id" | "createdAt" | "updatedAt" | "kind">,
) {
  const job = createMaintenanceJob({
    ...input,
    kind: "self_improve_review",
  });
  const handle = await acquireWorkerLockWithWait(job.agentDir);
  if (!handle) {
    return {
      status: "skipped",
      skipped: "locked",
      notice: buildMemoryMaintenanceNotice({
        status: "skipped",
        skipped: "locked",
      }),
    };
  }

  const startedAt = nowIso();
  try {
    await removeMatchingJobs(job.agentDir, job);
    try {
      const result = await processJob(job);
      const finishedAt = nowIso();
      const changedFiles = normalizeChangedFiles((result as any)?.changedFiles);
      const skipped = safeString((result as any)?.skipped).trim() || undefined;
      await appendHistoryRecord(job.agentDir, {
        id: job.id,
        kind: job.kind,
        status: "completed",
        trigger: job.trigger,
        sessionFile: job.sessionFile,
        leafId: job.leafId,
        snapshotKey: job.snapshotKey,
        startedAt,
        finishedAt,
        attempts: 1,
        skipped,
        outputPreview:
          truncateText(
            (result as any)?.output || (result as any)?.sessionSummary,
          ) || undefined,
        changedFiles,
      });
      return {
        status: "completed",
        result,
        notice: buildMemoryMaintenanceNotice({
          status: "completed",
          changedFiles,
          skipped,
        }),
      };
    } catch (error: unknown) {
      const finishedAt = nowIso();
      const message = normalizeErrorMessage(error);
      await appendHistoryRecord(job.agentDir, {
        id: job.id,
        kind: job.kind,
        status: "failed",
        trigger: job.trigger,
        sessionFile: job.sessionFile,
        leafId: job.leafId,
        snapshotKey: job.snapshotKey,
        startedAt,
        finishedAt,
        attempts: 1,
        error: message,
      });
      return {
        status: "failed",
        error: message,
        notice: buildMemoryMaintenanceNotice({ status: "failed" }),
      };
    }
  } finally {
    await releaseWorkerLock(job.agentDir, handle);
  }
}

export async function processQueuedMemoryJobs(agentDir: string) {
  const resolvedAgentDir = resolveAgentDir(agentDir);
  if (!resolvedAgentDir) return { skipped: "no-agent-dir" };
  const handle = await acquireWorkerLock(resolvedAgentDir);
  if (!handle) return { skipped: "locked" };
  let processed = 0;
  let failed = 0;
  const allChangedFiles: MaintenanceChangedFile[] = [];
  try {
    while (true) {
      const jobs = await loadQueue(resolvedAgentDir);
      const job = jobs[0];
      if (!job) break;
      const startedAt = nowIso();
      try {
        const result = await processJob(job);
        const finishedAt = nowIso();
        const changedFiles = normalizeChangedFiles(
          (result as any)?.changedFiles,
        );
        const skipped =
          safeString((result as any)?.skipped).trim() || undefined;
        await removeMatchingJobs(resolvedAgentDir, job);
        await appendHistoryRecord(resolvedAgentDir, {
          id: job.id,
          kind: job.kind,
          status: "completed",
          trigger: job.trigger,
          sessionFile: job.sessionFile,
          leafId: job.leafId,
          snapshotKey: job.snapshotKey,
          startedAt,
          finishedAt,
          attempts: Math.max(1, Number(job.attempts || 0) || 1),
          skipped,
          outputPreview: truncateText((result as any)?.output) || undefined,
          changedFiles,
        });
        await appendPendingMemoryMaintenanceNotice({
          agentDir: resolvedAgentDir,
          sessionFile: job.sessionFile,
          notice: buildMemoryMaintenanceNotice({
            status: "completed",
            changedFiles,
            skipped,
          }),
        });
        processed += 1;
        allChangedFiles.push(...changedFiles);
      } catch (error: unknown) {
        const finishedAt = nowIso();
        const message = normalizeErrorMessage(error);
        const attempts = Math.max(1, Number(job.attempts || 0) + 1);
        await removeMatchingJobs(resolvedAgentDir, job);
        await appendHistoryRecord(resolvedAgentDir, {
          id: job.id,
          kind: job.kind,
          status: "failed",
          trigger: job.trigger,
          sessionFile: job.sessionFile,
          leafId: job.leafId,
          snapshotKey: job.snapshotKey,
          startedAt,
          finishedAt,
          attempts,
          error: message,
        });
        await appendPendingMemoryMaintenanceNotice({
          agentDir: resolvedAgentDir,
          sessionFile: job.sessionFile,
          notice: buildMemoryMaintenanceNotice({ status: "failed" }),
        });
        failed += 1;
      }
    }
    return {
      skipped: "",
      processed,
      failed,
      retried: 0,
      notice: buildMemoryMaintenanceNotice({
        status: failed > 0 ? "failed" : "completed",
        changedFiles: allChangedFiles,
      }),
    };
  } finally {
    await releaseWorkerLock(resolvedAgentDir, handle);
  }
}

export function spawnQueuedMemoryWorker(agentDir: string) {
  const resolvedAgentDir = resolveAgentDir(agentDir);
  if (!resolvedAgentDir) return false;
  const workerPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "worker.js",
  );
  if (!fssync.existsSync(workerPath)) return false;
  const child = spawn(
    process.execPath,
    [workerPath, "--agent-dir", resolvedAgentDir],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.unref();
  return true;
}
