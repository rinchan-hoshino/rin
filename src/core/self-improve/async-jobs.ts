import fs, { type FileHandle } from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import lockfile from "proper-lockfile";

import {
  acknowledgeSelfImproveAuditObservation,
  reportSelfImproveAuditObservationError,
} from "./audit-observer.js";
import { runMaintainerUnderMaintenanceLock } from "./maintainer.js";
import { asArray } from "../json-utils.js";
import {
  readJsonFile,
  stringifyJson,
  writeJsonAtomic,
} from "../platform/fs.js";
import { sleep } from "../platform/process.js";
import { normalizeSessionValue } from "../session/ref.js";
import { nowIso, safeString, uniqueStrings } from "./core/utils.js";
import {
  resolveSafeSelfImprovePath,
  sanitizeSelfImproveHistoryText,
  type SelfImproveRunAuditHandle,
  type SelfImproveRunAuditReference,
} from "./run-audit.js";
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
  // Persisted before agent execution; its presence makes crash recovery at-most-once.
  executionStartedAt?: string;
  lastError?: string;
  lastAttemptAt?: string;
};

type MaintenanceChangedFile = {
  path: string;
  change: "created" | "updated" | "deleted";
};

type MaintenanceHistoryRecord = {
  id: string;
  runId?: string;
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
  audit?: SelfImproveRunAuditReference;
  auditError?: string;
  historyRedacted?: boolean;
  historyTruncated?: boolean;
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
  return asArray<Record<string, unknown>>(parsed)
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        safeString(item.kind).trim() !== "session_summary",
    )
    .map((item) => {
      const legacyStartedAt = safeString(item.auditStartedAt).trim();
      const job = { ...item } as MaintenanceJob;
      if (!job.executionStartedAt && legacyStartedAt) {
        job.executionStartedAt = legacyStartedAt;
      }
      delete (job as MaintenanceJob & { auditStartedAt?: string })
        .auditStartedAt;
      return job;
    });
}

async function saveQueue(agentDir: string, jobs: MaintenanceJob[]) {
  await ensureStateDir(agentDir);
  const queuePath = maintenanceQueuePath(agentDir);
  writeJsonAtomic(queuePath, jobs);
  const queueHandle = await fs.open(queuePath, "r+");
  try {
    await queueHandle.sync();
  } finally {
    await queueHandle.close();
  }
  const directoryHandle = await fs.open(path.dirname(queuePath), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
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
  if (existing && !existing.executionStartedAt) {
    existing.updatedAt = nextJob.updatedAt;
    existing.kind = nextJob.kind;
    existing.trigger = nextJob.trigger;
    existing.leafId = nextJob.leafId;
    existing.snapshotKey = nextJob.snapshotKey;
    existing.additionalExtensionPaths = nextJob.additionalExtensionPaths;
    existing.attempts = undefined;
    existing.lastError = undefined;
    existing.lastAttemptAt = undefined;
  } else if (!existing) {
    jobs.push(nextJob);
  }
  await saveQueue(nextJob.agentDir, jobs);
}

async function requeueMaintenanceJob(job: MaintenanceJob) {
  const jobs = await loadQueue(job.agentDir);
  const existingIndex = jobs.findIndex((entry) => entry.id === job.id);
  if (existingIndex >= 0) jobs[existingIndex] = job;
  else jobs.unshift(job);
  await saveQueue(job.agentDir, jobs);
}

export async function enqueueSelfImproveMaintenanceJob(
  input: Omit<MaintenanceJob, "id" | "createdAt" | "updatedAt" | "kind">,
) {
  await enqueueMaintenanceJob({
    ...input,
    kind: "self_improve_review",
  });
}

const WORKER_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

type MaintenanceWorkerLock = {
  pid: number;
  createdAt: string;
  updatedAt: string;
  activeJob?: Pick<
    MaintenanceJob,
    "id" | "kind" | "trigger" | "sessionFile" | "leafId" | "snapshotKey"
  >;
};

function processExists(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lockIsExpired(lock: unknown, nowMs = Date.now()) {
  const record = lock && typeof lock === "object" ? (lock as any) : {};
  const timestamp = Date.parse(
    safeString(record.updatedAt || record.createdAt).trim(),
  );
  if (!Number.isFinite(timestamp)) return true;
  return nowMs - timestamp > WORKER_LOCK_STALE_MS;
}

function lockPayload(job?: MaintenanceJob): MaintenanceWorkerLock {
  const timestamp = nowIso();
  return {
    pid: process.pid,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(job
      ? {
          activeJob: {
            id: job.id,
            kind: job.kind,
            trigger: job.trigger,
            sessionFile: job.sessionFile,
            leafId: job.leafId,
            snapshotKey: job.snapshotKey,
          },
        }
      : {}),
  };
}

async function writeWorkerLock(agentDir: string, job?: MaintenanceJob) {
  await fs.writeFile(
    maintenanceLockPath(agentDir),
    stringifyJson(lockPayload(job)),
    "utf8",
  );
}

async function closeAndRemoveWorkerLock(
  filePath: string,
  handle: fs.FileHandle | null,
) {
  try {
    await handle?.close();
  } catch {}
  try {
    await fs.rm(filePath, { force: true });
  } catch {}
}

async function createWorkerLock(filePath: string, job?: MaintenanceJob) {
  const handle = await fs.open(filePath, "wx");
  try {
    await handle.writeFile(stringifyJson(lockPayload(job)), "utf8");
    return handle;
  } catch (error) {
    await closeAndRemoveWorkerLock(filePath, handle);
    throw error;
  }
}

type WorkerLockState = "active" | "missing" | "stale";

async function inspectWorkerLock(filePath: string): Promise<WorkerLockState> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(filePath);
  } catch (error: any) {
    return error?.code === "ENOENT" ? "missing" : "active";
  }
  if (!stat.isFile()) return "active";

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid || 0);
    return !processExists(pid) || lockIsExpired(parsed) ? "stale" : "active";
  } catch {
    return Date.now() - stat.mtimeMs > WORKER_LOCK_STALE_MS
      ? "stale"
      : "active";
  }
}

async function reclaimWorkerLock(filePath: string, job?: MaintenanceJob) {
  let releaseReclaimLock: (() => Promise<void>) | undefined;
  try {
    releaseReclaimLock = await lockfile.lock(filePath, {
      realpath: false,
      lockfilePath: `${filePath}.reclaim`,
      stale: 60_000,
      update: 10_000,
      retries: 0,
    });
  } catch {
    return null;
  }

  let handle: fs.FileHandle | null = null;
  try {
    const state = await inspectWorkerLock(filePath);
    if (state === "active") return null;
    if (state === "stale") await fs.rm(filePath, { force: true });
    handle = await createWorkerLock(filePath, job);
  } catch {
    handle = null;
  } finally {
    try {
      await releaseReclaimLock();
    } catch {
      if (handle) await closeAndRemoveWorkerLock(filePath, handle);
      handle = null;
    }
  }
  return handle;
}

async function acquireWorkerLock(agentDir: string, job?: MaintenanceJob) {
  await ensureStateDir(agentDir);
  const filePath = maintenanceLockPath(agentDir);
  try {
    return await createWorkerLock(filePath, job);
  } catch (error: any) {
    if (error?.code !== "EEXIST") return null;
  }

  const state = await inspectWorkerLock(filePath);
  if (state === "active") return null;
  if (state === "missing") {
    try {
      return await createWorkerLock(filePath, job);
    } catch {
      return null;
    }
  }
  return await reclaimWorkerLock(filePath, job);
}

async function releaseWorkerLock(
  agentDir: string,
  handle: fs.FileHandle | null,
) {
  await closeAndRemoveWorkerLock(maintenanceLockPath(agentDir), handle);
}

async function acquireWorkerLockWithWait(
  agentDir: string,
  timeoutMs = 30 * 60 * 1000,
  job?: MaintenanceJob,
) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    const handle = await acquireWorkerLock(agentDir, job);
    if (handle) return handle;
    if (Date.now() >= deadline) return null;
    await sleep(250);
  }
}

export async function acquireSelfImproveMaintenanceLock(
  agentDir: string,
  timeoutMs = 30 * 60 * 1000,
) {
  return await acquireWorkerLockWithWait(agentDir, timeoutMs);
}

export async function releaseSelfImproveMaintenanceLock(
  agentDir: string,
  handle: fs.FileHandle | null,
) {
  await releaseWorkerLock(agentDir, handle);
}

async function removeMatchingJobs(
  agentDir: string,
  target: MaintenanceJob,
  deleteEmptyQueue = false,
) {
  const jobs = await loadQueue(agentDir);
  const remaining = jobs.filter((job) => !sameJob(job, target));
  if (remaining.length === jobs.length) return;
  if (deleteEmptyQueue && remaining.length === 0) {
    const queuePath = maintenanceQueuePath(agentDir);
    await fs.rm(queuePath, { force: true });
    const directoryHandle = await fs.open(path.dirname(queuePath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return;
  }
  await saveQueue(agentDir, remaining);
}

function normalizeAuditReference(
  value: unknown,
): SelfImproveRunAuditReference | undefined {
  const record = value && typeof value === "object" ? (value as any) : {};
  const auditPath = safeString(record.path).trim();
  const digest = safeString(record.sha256).trim();
  if (!auditPath || !/^[a-f0-9]{64}$/.test(digest)) return undefined;
  return {
    version: 1,
    auditId: /^[a-f0-9]{64}$/.test(safeString(record.auditId).trim())
      ? safeString(record.auditId).trim()
      : undefined,
    path: auditPath,
    sha256: digest,
    complete: record.complete === true,
    redacted: record.redacted === true,
    truncated: record.truncated === true,
  };
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

export function sanitizeMaintenanceHistoryRecord(
  record: MaintenanceHistoryRecord,
) {
  let historyRedacted = false;
  let historyTruncated = false;
  const text = (value: string | undefined, maxBytes: number) => {
    if (!value) return undefined;
    const sanitized = sanitizeSelfImproveHistoryText(value, maxBytes);
    historyRedacted ||= sanitized.redacted;
    historyTruncated ||= sanitized.truncated;
    return sanitized.text || undefined;
  };
  const outputPreview = text(record.outputPreview, 256 * 1024);
  return {
    ...record,
    trigger: text(record.trigger, 4 * 1024),
    sessionFile: text(record.sessionFile, 4 * 1024),
    leafId: text(record.leafId, 4 * 1024),
    snapshotKey: text(record.snapshotKey, 4 * 1024),
    skipped: text(record.skipped, 4 * 1024),
    error: text(record.error, 64 * 1024),
    auditError: text(record.auditError, 64 * 1024),
    outputPreview: truncateText(outputPreview, 800) || undefined,
    changedFiles: record.changedFiles?.map((entry) => ({
      ...entry,
      path: text(entry.path, 4 * 1024) || "[REDACTED]",
    })),
    historyRedacted: historyRedacted || undefined,
    historyTruncated: historyTruncated || undefined,
  } satisfies MaintenanceHistoryRecord;
}

function recoverHistoryText(existing: string) {
  if (!existing || existing.endsWith("\n")) return existing;
  const lastNewline = existing.lastIndexOf("\n");
  const prefix = lastNewline >= 0 ? existing.slice(0, lastNewline + 1) : "";
  const tail = existing.slice(lastNewline + 1);
  try {
    JSON.parse(tail);
    return `${existing}\n`;
  } catch {
    return prefix;
  }
}

async function writePrivateHistoryAtomic(filePath: string, content: string) {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, filePath);
    const directoryHandle = await fs.open(path.dirname(filePath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await fs.rm(tempPath, { force: true });
  }
}

async function appendHistoryRecord(
  agentDir: string,
  record: MaintenanceHistoryRecord,
) {
  let historyPath = await resolveSafeSelfImprovePath(
    agentDir,
    maintenanceHistoryPath(agentDir),
  );
  await fs.mkdir(path.dirname(historyPath), { recursive: true, mode: 0o700 });
  historyPath = await resolveSafeSelfImprovePath(agentDir, historyPath);
  const sanitized = sanitizeMaintenanceHistoryRecord(record);
  const rawExisting = fssync.existsSync(historyPath)
    ? await fs.readFile(historyPath, "utf8")
    : "";
  const existing = recoverHistoryText(rawExisting);
  if (existing !== rawExisting) {
    await writePrivateHistoryAtomic(historyPath, existing);
  }
  let existingRecords: any[];
  try {
    existingRecords = existing
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    throw new Error("self_improve_audit_history_corrupt");
  }
  const baseRecordId = sanitized.id;
  const identity =
    sanitized.audit?.sha256 ||
    sanitized.audit?.auditId ||
    createHash("sha256")
      .update(
        JSON.stringify({
          id: baseRecordId,
          startedAt: sanitized.startedAt,
          sessionFile: sanitized.sessionFile,
          leafId: sanitized.leafId,
          snapshotKey: sanitized.snapshotKey,
        }),
      )
      .digest("hex");
  const sameRun = (entry: any) =>
    entry?.id === baseRecordId || entry?.runId === baseRecordId;
  if (
    sanitized.audit?.auditId &&
    existingRecords.some(
      (entry) =>
        entry?.audit?.auditId === sanitized.audit?.auditId &&
        (!sameRun(entry) ||
          entry?.kind !== sanitized.kind ||
          entry?.status !== sanitized.status ||
          entry?.audit?.version !== sanitized.audit?.version ||
          entry?.audit?.path !== sanitized.audit?.path ||
          entry?.audit?.sha256 !== sanitized.audit?.sha256 ||
          entry?.audit?.complete !== sanitized.audit?.complete ||
          entry?.audit?.redacted !== sanitized.audit?.redacted ||
          entry?.audit?.truncated !== sanitized.audit?.truncated),
    )
  ) {
    throw new Error("self_improve_audit_history_corrupt");
  }
  if (
    existingRecords.some(
      (entry) =>
        sameRun(entry) &&
        (sanitized.audit
          ? sanitized.audit.auditId
            ? entry?.audit?.auditId === sanitized.audit.auditId
            : entry?.audit?.sha256 === sanitized.audit.sha256 &&
              entry?.audit?.path === sanitized.audit.path &&
              entry?.status === sanitized.status
          : !entry?.audit && entry?.startedAt === sanitized.startedAt),
    )
  ) {
    await fs.chmod(historyPath, 0o600);
    const historyHandle = await fs.open(historyPath, "r+");
    try {
      await historyHandle.sync();
    } finally {
      await historyHandle.close();
    }
    const directoryHandle = await fs.open(path.dirname(historyPath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return;
  }
  if (existingRecords.some(sameRun)) {
    sanitized.id = `${baseRecordId}@${identity.slice(0, 12)}`;
  }
  sanitized.runId = baseRecordId;
  await writePrivateHistoryAtomic(
    historyPath,
    `${existing}${JSON.stringify(sanitized)}\n`,
  );
}

async function commitHistoryRecord(
  agentDir: string,
  record: MaintenanceHistoryRecord,
) {
  try {
    await appendHistoryRecord(agentDir, record);
    return true;
  } catch (error) {
    reportSelfImproveAuditObservationError(error);
    return false;
  }
}

export async function appendMaintenanceHistoryRecord(
  agentDir: string,
  record: MaintenanceHistoryRecord,
) {
  await appendHistoryRecord(resolveAgentDir(agentDir), record);
}

async function acknowledgeCommittedResultAudit(
  agentDir: string,
  audit: unknown,
  handle: unknown,
  auditError?: string,
) {
  const result = await acknowledgeSelfImproveAuditObservation({
    agentDir,
    handle: handle as SelfImproveRunAuditHandle | undefined,
    reference: audit as SelfImproveRunAuditReference | undefined,
    auditError,
  });
  if (result && result !== auditError) {
    reportSelfImproveAuditObservationError(result);
  }
}

function persistedExecutionStartedAt(job: MaintenanceJob) {
  return safeString(job.executionStartedAt).trim();
}

async function finalizeInterruptedJob(
  agentDir: string,
  job: MaintenanceJob,
  startedAt: string,
) {
  await commitHistoryRecord(agentDir, {
    id: job.id,
    kind: job.kind,
    status: "failed",
    trigger: job.trigger,
    sessionFile: job.sessionFile,
    leafId: job.leafId,
    snapshotKey: job.snapshotKey,
    startedAt,
    finishedAt: nowIso(),
    attempts: Math.max(1, Number(job.attempts || 0) + 1),
    error: "maintenance_job_interrupted_execution",
  });
  await removeMatchingJobs(agentDir, job, true);
}

async function processJob(
  job: MaintenanceJob,
  startedAt: string,
  maintenanceLockHandle: FileHandle,
) {
  const agentDir = resolveAgentDir(job.agentDir);
  const sessionFile = resolveSessionFile(job.sessionFile);
  const leafId = safeString(job.leafId).trim() || undefined;
  if (!agentDir || !sessionFile) {
    throw new Error("maintenance_job_invalid_payload");
  }
  return await runMaintainerUnderMaintenanceLock({} as any, {
    agentDir,
    sessionFile,
    leafId,
    trigger: job.trigger,
    additionalExtensionPaths: job.additionalExtensionPaths,
    runId: job.id,
    startedAt,
    snapshotKey: job.snapshotKey,
    maintenanceLockHandle,
  });
}

export async function runSelfImproveMaintenanceJobNow(
  input: Omit<MaintenanceJob, "id" | "createdAt" | "updatedAt" | "kind">,
) {
  const proposedJob = createMaintenanceJob({
    ...input,
    kind: "self_improve_review",
  });
  let job = proposedJob;
  const handle = await acquireWorkerLockWithWait(
    proposedJob.agentDir,
    30 * 60 * 1000,
    proposedJob,
  );
  if (!handle) {
    return {
      status: "skipped",
      skipped: "locked",
    };
  }

  try {
    const persistedJob = (await loadQueue(proposedJob.agentDir)).find(
      (candidate) =>
        candidate.kind === "self_improve_review" &&
        sameJob(candidate, proposedJob),
    );
    job = persistedJob || proposedJob;
    const interruptedAt = persistedExecutionStartedAt(job);
    if (interruptedAt) {
      await finalizeInterruptedJob(job.agentDir, job, interruptedAt);
      return {
        status: "failed",
        error: "maintenance_job_interrupted_execution",
      };
    }
    const startedAt = nowIso();
    job.executionStartedAt = startedAt;
    await requeueMaintenanceJob(job);
    let result: any;
    try {
      result = await processJob(job, startedAt, handle);
    } catch (error: unknown) {
      const finishedAt = nowIso();
      const message = normalizeErrorMessage(error);
      const auditError =
        safeString((error as any)?.selfImproveAuditError).trim() || undefined;
      const historyCommitted = await commitHistoryRecord(job.agentDir, {
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
        audit: normalizeAuditReference((error as any)?.selfImproveAudit),
        auditError,
      });
      if (historyCommitted) {
        await acknowledgeCommittedResultAudit(
          job.agentDir,
          (error as any)?.selfImproveAudit,
          (error as any)?.selfImproveAuditHandle,
          auditError,
        );
      }
      await removeMatchingJobs(job.agentDir, job, true);
      return {
        status: "failed",
        error: message,
      };
    }
    const finishedAt = nowIso();
    const changedFiles = normalizeChangedFiles(result?.changedFiles);
    const skipped = safeString(result?.skipped).trim() || undefined;
    const auditError = safeString(result?.auditError).trim() || undefined;
    const historyCommitted = await commitHistoryRecord(job.agentDir, {
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
        safeString(result?.output || result?.sessionSummary).trim() ||
        undefined,
      changedFiles,
      audit: normalizeAuditReference(result?.audit),
      auditError,
    });
    if (historyCommitted) {
      await acknowledgeCommittedResultAudit(
        job.agentDir,
        result?.audit,
        result?.auditHandle,
        auditError,
      );
    }
    await removeMatchingJobs(job.agentDir, job, true);
    return {
      status: "completed",
      result,
    };
  } catch (error) {
    await requeueMaintenanceJob(job);
    throw error;
  } finally {
    await releaseWorkerLock(job.agentDir, handle);
  }
}

export async function processQueuedSelfImproveJobs(agentDir: string) {
  const resolvedAgentDir = resolveAgentDir(agentDir);
  if (!resolvedAgentDir) return { skipped: "no-agent-dir" };
  const handle = await acquireWorkerLock(resolvedAgentDir);
  if (!handle) return { skipped: "locked" };
  let processed = 0;
  let failed = 0;
  try {
    while (true) {
      const jobs = await loadQueue(resolvedAgentDir);
      const job = jobs[0];
      if (!job) break;
      const interruptedAt = persistedExecutionStartedAt(job);
      if (interruptedAt) {
        await finalizeInterruptedJob(resolvedAgentDir, job, interruptedAt);
        failed += 1;
        continue;
      }
      const startedAt = nowIso();
      job.executionStartedAt = startedAt;
      job.updatedAt = nowIso();
      await saveQueue(resolvedAgentDir, jobs);
      await writeWorkerLock(resolvedAgentDir, job);
      let result: any;
      try {
        result = await processJob(job, startedAt, handle);
      } catch (error: unknown) {
        const finishedAt = nowIso();
        const message = normalizeErrorMessage(error);
        const attempts = Math.max(1, Number(job.attempts || 0) + 1);
        const auditError =
          safeString((error as any)?.selfImproveAuditError).trim() || undefined;
        const historyCommitted = await commitHistoryRecord(resolvedAgentDir, {
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
          audit: normalizeAuditReference((error as any)?.selfImproveAudit),
          auditError,
        });
        if (historyCommitted) {
          await acknowledgeCommittedResultAudit(
            resolvedAgentDir,
            (error as any)?.selfImproveAudit,
            (error as any)?.selfImproveAuditHandle,
            auditError,
          );
        }
        await removeMatchingJobs(resolvedAgentDir, job);
        failed += 1;
        continue;
      }
      const finishedAt = nowIso();
      const changedFiles = normalizeChangedFiles(result?.changedFiles);
      const skipped = safeString(result?.skipped).trim() || undefined;
      const auditError = safeString(result?.auditError).trim() || undefined;
      const historyCommitted = await commitHistoryRecord(resolvedAgentDir, {
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
        outputPreview: safeString(result?.output).trim() || undefined,
        changedFiles,
        audit: normalizeAuditReference(result?.audit),
        auditError,
      });
      if (historyCommitted) {
        await acknowledgeCommittedResultAudit(
          resolvedAgentDir,
          result?.audit,
          result?.auditHandle,
          auditError,
        );
      }
      await removeMatchingJobs(resolvedAgentDir, job);
      processed += 1;
    }
    return {
      skipped: "",
      processed,
      failed,
      retried: 0,
    };
  } finally {
    await releaseWorkerLock(resolvedAgentDir, handle);
  }
}

const queuedMemoryWorkers = new Map<string, ReturnType<typeof spawn>>();

function hasQueuedSelfImproveJobs(agentDir: string) {
  try {
    const parsed = JSON.parse(
      fssync.readFileSync(maintenanceQueuePath(agentDir), "utf8"),
    );
    return asArray<MaintenanceJob>(parsed).some(
      (item) =>
        item &&
        typeof item === "object" &&
        safeString((item as any).kind).trim() !== "session_summary",
    );
  } catch {
    return false;
  }
}

export function spawnQueuedMemoryWorker(agentDir: string) {
  const resolvedAgentDir = resolveAgentDir(agentDir);
  if (!resolvedAgentDir || !hasQueuedSelfImproveJobs(resolvedAgentDir)) {
    return false;
  }
  const existing = queuedMemoryWorkers.get(resolvedAgentDir);
  if (existing && existing.exitCode === null && !existing.killed) return false;

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
      stdio: ["ignore", "ignore", "inherit"],
      windowsHide: true,
    },
  );
  queuedMemoryWorkers.set(resolvedAgentDir, child);
  const forgetChild = () => {
    if (queuedMemoryWorkers.get(resolvedAgentDir) === child) {
      queuedMemoryWorkers.delete(resolvedAgentDir);
    }
  };
  child.once("error", forgetChild);
  child.once("exit", forgetChild);
  child.unref();
  return true;
}

export function startQueuedMemoryWorkerSupervisor(
  agentDir: string,
  options: { intervalMs?: number } = {},
) {
  const intervalMs = Math.max(10, Number(options.intervalMs) || 15_000);
  let stopped = false;
  const wake = () => !stopped && spawnQueuedMemoryWorker(agentDir);
  wake();
  const timer = setInterval(wake, intervalMs);
  timer.unref();
  return {
    wake,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
