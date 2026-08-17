import fs from "node:fs/promises";
import path from "node:path";

import lockfile from "proper-lockfile";

import { asArray } from "../json-utils.js";
import { readJsonFileOrDefault, writeJsonAtomic } from "../platform/fs.js";
import { nowIso, safeString, uniqueStrings } from "./core/utils.js";
import {
  maintenanceHistoryPath,
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
  additionalExtensionPaths?: string[];
  attempts?: number;
  // Persisted before agent execution; its presence makes crash recovery at-most-once.
  executionStartedAt?: string;
  lastError?: string;
  lastAttemptAt?: string;
};

export function resolveAgentDir(value: unknown) {
  const normalized = safeString(value).trim();
  return normalized ? path.resolve(normalized) : "";
}

export function resolveSessionFile(value: unknown) {
  const normalized = safeString(value).trim();
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

export async function ensureStateDir(agentDir: string) {
  await fs.mkdir(selfImproveStateDir(agentDir), { recursive: true });
}

export async function withQueueMutationLock<T>(
  agentDir: string,
  action: () => Promise<T>,
): Promise<T> {
  await ensureStateDir(agentDir);
  const queueFile = maintenanceQueuePath(agentDir);
  const release = await lockfile.lock(selfImproveStateDir(agentDir), {
    realpath: false,
    lockfilePath: `${queueFile}.enqueue-lock`,
    stale: 60_000,
    update: 10_000,
    retries: {
      retries: 100,
      factor: 1.2,
      minTimeout: 5,
      maxTimeout: 50,
      randomize: true,
    },
  });
  try {
    return await action();
  } finally {
    await release();
  }
}

export async function loadQueue(agentDir: string): Promise<MaintenanceJob[]> {
  const parsed = readJsonFileOrDefault<unknown>(
    maintenanceQueuePath(agentDir),
    [],
  );
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

export async function saveQueue(agentDir: string, jobs: MaintenanceJob[]) {
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

export function sameJob(
  a: Partial<MaintenanceJob>,
  b: Partial<MaintenanceJob>,
) {
  const sameBase =
    safeString(a.kind).trim() === safeString(b.kind).trim() &&
    safeString(a.agentDir).trim() === safeString(b.agentDir).trim() &&
    safeString(a.sessionFile).trim() === safeString(b.sessionFile).trim();
  return (
    sameBase && safeString(a.leafId).trim() === safeString(b.leafId).trim()
  );
}

async function maintenanceHistoryContainsJob(job: MaintenanceJob) {
  if (!safeString(job.leafId).trim()) return false;
  try {
    const text = await fs.readFile(
      maintenanceHistoryPath(job.agentDir),
      "utf8",
    );
    for (const line of text.split(/\r?\n/g)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (sameJob({ ...record, agentDir: job.agentDir }, job)) return true;
      } catch {}
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  return false;
}

function defaultTrigger(_kind: MaintenanceJob["kind"]) {
  return "self_improve:review";
}

export function createMaintenanceJob(
  input: Omit<MaintenanceJob, "id" | "createdAt" | "updatedAt">,
): MaintenanceJob {
  const agentDir = resolveAgentDir(input.agentDir);
  const sessionFile = resolveSessionFile(input.sessionFile);
  const kind: MaintenanceJob["kind"] = "self_improve_review";
  const trigger = safeString(input.trigger).trim() || defaultTrigger(kind);
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
    additionalExtensionPaths: normalizeAdditionalExtensionPaths(
      input.additionalExtensionPaths,
    ),
  };
}

async function enqueueMaintenanceJob(
  input: Omit<MaintenanceJob, "id" | "createdAt" | "updatedAt">,
) {
  const nextJob = createMaintenanceJob(input);
  await withQueueMutationLock(nextJob.agentDir, async () => {
    if (await maintenanceHistoryContainsJob(nextJob)) return;
    const jobs = await loadQueue(nextJob.agentDir);
    const existing = jobs.find((job) => sameJob(job, nextJob));
    if (existing && !existing.executionStartedAt) {
      existing.updatedAt = nextJob.updatedAt;
      existing.kind = nextJob.kind;
      existing.trigger = nextJob.trigger;
      existing.leafId = nextJob.leafId;
      existing.additionalExtensionPaths = nextJob.additionalExtensionPaths;
      existing.attempts = undefined;
      existing.lastError = undefined;
      existing.lastAttemptAt = undefined;
    } else if (!existing) {
      jobs.push(nextJob);
    }
    await saveQueue(nextJob.agentDir, jobs);
  });
}

export async function requeueMaintenanceJob(job: MaintenanceJob) {
  await withQueueMutationLock(job.agentDir, async () => {
    const jobs = await loadQueue(job.agentDir);
    const existingIndex = jobs.findIndex((entry) => entry.id === job.id);
    if (existingIndex >= 0) jobs[existingIndex] = job;
    else if (!jobs.some((entry) => sameJob(entry, job))) jobs.unshift(job);
    await saveQueue(job.agentDir, jobs);
  });
}

export async function enqueueSelfImproveMaintenanceJob(
  input: Omit<MaintenanceJob, "id" | "createdAt" | "updatedAt" | "kind">,
) {
  await enqueueMaintenanceJob({
    ...input,
    kind: "self_improve_review",
  });
}
