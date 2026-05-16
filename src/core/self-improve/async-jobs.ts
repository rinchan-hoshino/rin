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

type MaintenanceHistoryRecord = {
  id: string;
  kind: MaintenanceJob["kind"];
  status: "completed" | "failed" | "retry_scheduled";
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

function processExists(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
      if (!processExists(pid)) {
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

async function replaceMatchingJob(
  agentDir: string,
  target: MaintenanceJob,
  replacement?: MaintenanceJob,
) {
  const jobs = await loadQueue(agentDir);
  const remaining = jobs.filter((job) => !sameJob(job, target));
  if (replacement) remaining.push(replacement);
  await saveQueue(agentDir, remaining);
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

function normalizeErrorMessage(error: unknown) {
  return safeString(
    (error as any)?.message || error || "maintenance_job_failed",
  ).trim();
}

function isPermanentJobError(message: string) {
  return [
    "maintenance_job_invalid_input",
    "maintenance_job_invalid_payload",
    "maintenance_job_missing_session_file:",
    "maintenance_job_invalid_session_file:",
    "session_file_required",
    "Cannot fork: source session file is empty or invalid:",
  ].some((needle) => message.includes(needle));
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
    return { status: "skipped", skipped: "locked" };
  }

  const startedAt = nowIso();
  try {
    await removeMatchingJobs(job.agentDir, job);
    try {
      const result = await processJob(job);
      const finishedAt = nowIso();
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
        skipped: safeString((result as any)?.skipped).trim() || undefined,
        outputPreview:
          truncateText(
            (result as any)?.output || (result as any)?.sessionSummary,
          ) || undefined,
        changedFiles: normalizeChangedFiles((result as any)?.changedFiles),
      });
      return { status: "completed", result };
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
      return { status: "failed", error: message };
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
  let retried = 0;
  const deferredRetryIds = new Set<string>();
  try {
    while (true) {
      const jobs = await loadQueue(resolvedAgentDir);
      const job = jobs[0];
      if (!job) break;
      if (deferredRetryIds.has(job.id)) break;
      const startedAt = nowIso();
      try {
        const result = await processJob(job);
        const finishedAt = nowIso();
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
          skipped: safeString((result as any)?.skipped).trim() || undefined,
          outputPreview: truncateText((result as any)?.output) || undefined,
          changedFiles: normalizeChangedFiles((result as any)?.changedFiles),
        });
        processed += 1;
      } catch (error: unknown) {
        const finishedAt = nowIso();
        const message = normalizeErrorMessage(error);
        const attempts = Math.max(1, Number(job.attempts || 0) + 1);
        const updatedJob: MaintenanceJob = {
          ...job,
          attempts,
          updatedAt: finishedAt,
          lastAttemptAt: finishedAt,
          lastError: message,
        };
        const permanent = isPermanentJobError(message);
        if (permanent || attempts >= 3) {
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
          failed += 1;
          continue;
        }
        await replaceMatchingJob(resolvedAgentDir, job, updatedJob);
        await appendHistoryRecord(resolvedAgentDir, {
          id: job.id,
          kind: job.kind,
          status: "retry_scheduled",
          trigger: job.trigger,
          sessionFile: job.sessionFile,
          leafId: job.leafId,
          snapshotKey: job.snapshotKey,
          startedAt,
          finishedAt,
          attempts,
          error: message,
        });
        retried += 1;
        deferredRetryIds.add(job.id);
      }
    }
    return { skipped: "", processed, failed, retried };
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
