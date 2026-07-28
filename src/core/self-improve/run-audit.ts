import crypto from "node:crypto";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";

import { createTwoFilesPatch } from "diff";

import {
  selfImprovePromptsDir,
  selfImproveSkillsDir,
  selfImproveStateDir,
} from "./paths.js";

export type SelfImproveRunAuditPolicy = {
  maxOutputBytes: number;
  maxErrorBytes: number;
  maxMetadataBytes: number;
  maxPatchBytes: number;
  maxSnapshotFileBytes: number;
  maxSnapshotBytes: number;
  maxArtifacts: number;
  maxAgeMs: number;
};

export type SelfImproveRunAuditSource = {
  sessionFile?: string;
  leafId?: string;
  snapshotKey?: string;
  trigger?: string;
};

export type SelfImproveRunAuditHandle = {
  version: 1;
  runId: string;
  auditId: string;
  storageId: string;
  pendingPath: string;
  executionStartedPath: string;
  executionInterrupted?: boolean;
  acknowledged?: {
    reference: SelfImproveRunAuditReference;
    status: "completed" | "failed";
  };
  completedPath?: string;
};

export type SelfImproveRunAuditReference = {
  version: 1;
  auditId?: string;
  path: string;
  sha256: string;
  complete: boolean;
  redacted: boolean;
  truncated: boolean;
};

export type CompletedSelfImproveRunAudit = SelfImproveRunAuditReference & {
  status: "completed" | "failed" | "skipped";
  evidenceRetained?: boolean;
  output?: string;
  error?: string;
  changedFiles: Array<{
    path: string;
    change: "created" | "updated" | "deleted";
  }>;
};

type SnapshotEntry = {
  path: string;
  pathSha256: string;
  sha256: string;
  bytes: number;
  text?: string;
  binary?: boolean;
  redacted?: boolean;
  truncated?: boolean;
};

type Snapshot = {
  rootSha256: string;
  entries: SnapshotEntry[];
  redacted: boolean;
  truncated: boolean;
};

type AcknowledgedAuditMarker = {
  version: 1;
  storageId: string;
  auditId: string;
  fileName: string;
  reference: SelfImproveRunAuditReference;
  status: "completed" | "failed";
  integritySha256: string;
};

type ExecutionStartedMarker = {
  version: 1;
  auditId: string;
  storageId: string;
  fileName: string;
  startedAt: string;
};

type PendingAudit = {
  version: 1;
  auditId: string;
  storageId: string;
  generationId: string;
  fileName: string;
  integritySha256: string;
  runId: string;
  runIdSha256: string;
  kind: string;
  startedAt: string;
  source?: SelfImproveRunAuditSource;
  policy: SelfImproveRunAuditPolicy;
  metadataRedacted: boolean;
  metadataTruncated: boolean;
  before: Snapshot;
};

const DEFAULT_POLICY: SelfImproveRunAuditPolicy = {
  maxOutputBytes: 256 * 1024,
  maxErrorBytes: 64 * 1024,
  maxMetadataBytes: 4 * 1024,
  maxPatchBytes: 512 * 1024,
  maxSnapshotFileBytes: 1024 * 1024,
  maxSnapshotBytes: 16 * 1024 * 1024,
  maxArtifacts: 500,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
};

const SECRET_KEY =
  "(?:(?:[A-Za-z0-9]+[_-])*)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret(?:[_-]?access[_-]?key)?|client[_-]?secret|password|passwd|passphrase|private[_-]?key|credentials?(?:[_-]?file)?)";
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g,
  /\b(?:sk|gh[pousr]|xox[baprs]|AKIA)[-_A-Za-z0-9]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(\bAuthorization\b["']?\s*[:=]\s*")[^"]*/gi,
  /(\bAuthorization\b["']?\s*[:=]\s*')[^']*/gi,
  /(\bAuthorization\b["']?\s*[:=]\s*)[^\r\n,;}]+/gi,
  new RegExp(`(\\b${SECRET_KEY}\\b["']?\\s*[=:]\\s*")[^"]*`, "gi"),
  new RegExp(`(\\b${SECRET_KEY}\\b["']?\\s*[=:]\\s*')[^']*`, "gi"),
  new RegExp(`(\\b${SECRET_KEY}\\b["']?\\s*[=:]\\s*)[^\\r\\n,;}]+`, "gi"),
  /([?&](?:token|key|secret|password|signature|sig)=)[^&#\s]+/gi,
];

function sha256(input: crypto.BinaryLike) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function policyWithDefaults(
  input?: Partial<SelfImproveRunAuditPolicy>,
): SelfImproveRunAuditPolicy {
  const merged = { ...DEFAULT_POLICY, ...(input || {}) };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isFinite(value) || value < 1) {
      throw new Error(`self_improve_audit_invalid_policy:${key}`);
    }
  }
  return merged;
}

function redactSensitiveText(input: string) {
  let text = input;
  let redacted = false;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (...args: any[]) => {
      redacted = true;
      const prefix = typeof args[1] === "string" ? args[1] : "";
      return `${prefix}[REDACTED]`;
    });
  }
  return { text, redacted };
}

function truncateUtf8(input: string, maxBytes: number) {
  const buffer = Buffer.from(input, "utf8");
  if (buffer.byteLength <= maxBytes) {
    return { text: input, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return {
    text: buffer.subarray(0, end).toString("utf8"),
    truncated: true,
  };
}

function sanitizeBoundedText(input: string, maxBytes: number) {
  const sanitized = redactSensitiveText(input);
  const bounded = truncateUtf8(sanitized.text, maxBytes);
  return {
    text: bounded.text,
    redacted: sanitized.redacted,
    truncated: bounded.truncated,
  };
}

export function sanitizeSelfImproveHistoryText(
  input: string,
  maxBytes: number,
) {
  return sanitizeBoundedText(String(input || ""), maxBytes);
}

function normalizeIsoTimestamp(input: string) {
  const value = String(input || "").trim();
  const timestamp = Date.parse(value);
  if (!value || !Number.isFinite(timestamp)) {
    throw new Error("self_improve_audit_invalid_timestamp");
  }
  return new Date(timestamp).toISOString();
}

function sanitizeSource(
  source: SelfImproveRunAuditSource | undefined,
  maxBytes: number,
) {
  if (!source) {
    return {
      source: undefined,
      redacted: false,
      truncated: false,
    };
  }
  let redacted = false;
  let truncated = false;
  const bounded = (value: string | undefined) => {
    if (!value) return undefined;
    const result = sanitizeBoundedText(value, maxBytes);
    redacted ||= result.redacted;
    truncated ||= result.truncated;
    return result.text;
  };
  return {
    source: {
      sessionFile: bounded(source.sessionFile),
      leafId: bounded(source.leafId),
      snapshotKey: bounded(source.snapshotKey),
      trigger: bounded(source.trigger),
    },
    redacted,
    truncated,
  };
}

async function collectFiles(dir: string): Promise<string[]> {
  if (!fssync.existsSync(dir)) return [];
  const stat = await fs.lstat(dir);
  if (stat.isSymbolicLink()) {
    throw new Error("self_improve_audit_symlink_path");
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("self_improve_audit_symlink_path");
    }
    if (entry.isDirectory()) files.push(...(await collectFiles(fullPath)));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function decodeText(buffer: Buffer) {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

async function captureSnapshot(
  agentDir: string,
  policy: SelfImproveRunAuditPolicy,
): Promise<Snapshot> {
  const root = path.resolve(agentDir);
  const promptsDir = selfImprovePromptsDir(root);
  const skillsDir = selfImproveSkillsDir(root);
  await assertSafeAgentPath(root, promptsDir);
  await assertSafeAgentPath(root, skillsDir);
  const files = [
    ...(await collectFiles(promptsDir)),
    ...(await collectFiles(skillsDir)),
  ].sort();
  const entries: SnapshotEntry[] = [];
  let capturedBytes = 0;
  let redacted = false;
  let truncated = false;
  for (const filePath of files) {
    const buffer = await fs.readFile(filePath);
    const relativePath = path.relative(root, filePath) || filePath;
    const sanitizedPath = sanitizeBoundedText(
      relativePath,
      policy.maxMetadataBytes,
    );
    const entry: SnapshotEntry = {
      path: sanitizedPath.text,
      pathSha256: sha256(relativePath),
      sha256: sha256(buffer),
      bytes: buffer.byteLength,
      redacted: sanitizedPath.redacted || undefined,
      truncated: sanitizedPath.truncated || undefined,
    };
    redacted ||= sanitizedPath.redacted;
    truncated ||= sanitizedPath.truncated;
    const text = decodeText(buffer);
    if (text === null) {
      entry.binary = true;
    } else if (
      buffer.byteLength > policy.maxSnapshotFileBytes ||
      capturedBytes + buffer.byteLength > policy.maxSnapshotBytes
    ) {
      entry.truncated = true;
      truncated = true;
    } else {
      const sanitized = redactSensitiveText(text);
      entry.text = sanitized.text;
      entry.redacted = entry.redacted || sanitized.redacted || undefined;
      capturedBytes += Buffer.byteLength(entry.text, "utf8");
      redacted ||= sanitized.redacted;
    }
    entries.push(entry);
  }
  const rootSha256 = sha256(
    entries.map((entry) => `${entry.pathSha256}\0${entry.sha256}\n`).join(""),
  );
  return { rootSha256, entries, redacted, truncated };
}

function safeRunFileName(runId: string, auditId: string) {
  const readable =
    runId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 96) || "run";
  return `${readable}-${auditId}`;
}

async function canonicalAgentRoot(agentDir: string) {
  return await fs.realpath(path.resolve(agentDir));
}

async function assertSafeAgentPath(agentDir: string, targetPath: string) {
  const root = path.resolve(agentDir);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("self_improve_audit_pending_path_outside_agent_dir");
  }
  const relative = path.relative(root, target);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error("self_improve_audit_symlink_path");
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
}

export async function resolveSafeSelfImprovePath(
  agentDir: string,
  targetPath: string,
) {
  const lexicalRoot = path.resolve(agentDir);
  const lexicalTarget = path.resolve(targetPath);
  if (
    lexicalTarget !== lexicalRoot &&
    !lexicalTarget.startsWith(`${lexicalRoot}${path.sep}`)
  ) {
    throw new Error("self_improve_audit_pending_path_outside_agent_dir");
  }
  const root = await canonicalAgentRoot(lexicalRoot);
  const target = path.resolve(root, path.relative(lexicalRoot, lexicalTarget));
  await assertSafeAgentPath(root, target);
  return target;
}

function pendingDir(agentDir: string) {
  return path.join(selfImproveStateDir(agentDir), "run-audits-pending");
}

function executionDir(agentDir: string) {
  return path.join(selfImproveStateDir(agentDir), "run-audits-executing");
}

function acknowledgedDir(agentDir: string) {
  return path.join(selfImproveStateDir(agentDir), "run-audits-acknowledged");
}

function auditsDir(agentDir: string) {
  return path.join(selfImproveStateDir(agentDir), "run-audits");
}

function relativeToAgent(agentDir: string, filePath: string) {
  return path
    .relative(path.resolve(agentDir), filePath)
    .split(path.sep)
    .join("/");
}

function completedAuditPath(
  agentDir: string,
  startedAt: string,
  runId: string,
  auditId: string,
) {
  const date = normalizeIsoTimestamp(startedAt).slice(0, 10);
  const root = path.resolve(auditsDir(agentDir));
  const filePath = path.resolve(
    root,
    date,
    `${safeRunFileName(runId, auditId)}.json`,
  );
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("self_improve_audit_pending_path_outside_agent_dir");
  }
  return filePath;
}

async function syncDirectory(dirPath: string) {
  const handle = await fs.open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectoryChain(agentDir: string, dirPath: string) {
  const root = path.resolve(agentDir);
  let current = path.resolve(dirPath);
  while (current === root || current.startsWith(`${root}${path.sep}`)) {
    await syncDirectory(current);
    if (current === root) break;
    current = path.dirname(current);
  }
}

async function writeJsonPrivate(
  agentDir: string,
  filePath: string,
  value: unknown,
  options: { exclusive?: boolean; preserveTempOnFailure?: boolean } = {},
) {
  await assertSafeAgentPath(agentDir, filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await assertSafeAgentPath(agentDir, filePath);
  await syncDirectoryChain(agentDir, path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let tempDurable = false;
  let promoted = false;
  try {
    const handle = await fs.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
      tempDurable = true;
    } finally {
      await handle.close();
    }
    if (options.exclusive) await fs.link(tempPath, filePath);
    else await fs.rename(tempPath, filePath);
    await syncDirectory(path.dirname(filePath));
    promoted = true;
  } finally {
    if (promoted || !tempDurable || !options.preserveTempOnFailure) {
      await fs.rm(tempPath, { force: true });
      await syncDirectory(path.dirname(tempPath));
    }
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readPrivateJson<T>(agentDir: string, filePath: string) {
  await assertSafeAgentPath(agentDir, filePath);
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("self_improve_audit_pending_mismatch");
  }
  return await readJson<T>(filePath);
}

function recordIntegritySha256(record: object) {
  return sha256(JSON.stringify(record));
}

function referenceOnly(
  reference: SelfImproveRunAuditReference,
): SelfImproveRunAuditReference {
  return {
    version: 1,
    auditId: reference.auditId,
    path: reference.path,
    sha256: reference.sha256,
    complete: reference.complete,
    redacted: reference.redacted,
    truncated: reference.truncated,
  };
}

function pendingIntegritySha256(
  pending: Omit<PendingAudit, "integritySha256">,
) {
  return recordIntegritySha256(pending);
}

function validatePendingAudit(
  pending: PendingAudit,
  expectedStorageId: string,
  expectedAuditId?: string,
  expectedFileName?: string,
) {
  const { integritySha256, ...unsigned } = pending;
  if (
    pending.version !== 1 ||
    pending.storageId !== expectedStorageId ||
    (expectedAuditId !== undefined && pending.auditId !== expectedAuditId) ||
    (expectedFileName !== undefined && pending.fileName !== expectedFileName) ||
    integritySha256 !== pendingIntegritySha256(unsigned)
  ) {
    throw new Error("self_improve_audit_pending_mismatch");
  }
  return policyWithDefaults(pending.policy);
}

async function readAcknowledgedMarker(
  agentDir: string,
  markerPath: string,
  expectedStorageId: string,
) {
  const stat = await fs.lstat(markerPath);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("self_improve_audit_pending_mismatch");
  }
  const marker = await readJson<AcknowledgedAuditMarker>(markerPath);
  const { integritySha256, ...unsigned } = marker;
  if (
    marker.version !== 1 ||
    path.resolve(path.dirname(markerPath)) !==
      path.resolve(acknowledgedDir(agentDir)) ||
    marker.fileName !== path.basename(markerPath) ||
    marker.storageId !== expectedStorageId ||
    marker.auditId !== marker.reference.auditId ||
    integritySha256 !== recordIntegritySha256(unsigned)
  ) {
    throw new Error("self_improve_audit_pending_mismatch");
  }
  return marker;
}

async function validateAcknowledgedMarkerDirectory(agentDir: string) {
  const root = acknowledgedDir(agentDir);
  await assertSafeAgentPath(agentDir, root);
  for (const markerPath of await listFilesEnding(root, "")) {
    const raw = await readJson<AcknowledgedAuditMarker>(markerPath);
    await readAcknowledgedMarker(agentDir, markerPath, raw.storageId);
  }
}

async function validateRecoveryStateDirectories(agentDir: string) {
  const pendingRoot = pendingDir(agentDir);
  const executionRoot = executionDir(agentDir);
  await assertSafeAgentPath(agentDir, pendingRoot);
  await assertSafeAgentPath(agentDir, executionRoot);
  const pendingByName = new Map<string, PendingAudit>();
  for (const pendingPath of await listFilesEnding(pendingRoot, "")) {
    const pending = await readPrivateJson<PendingAudit>(agentDir, pendingPath);
    validatePendingAudit(
      pending,
      pending.storageId,
      pending.auditId,
      path.basename(pendingPath),
    );
    pendingByName.set(path.basename(pendingPath), pending);
  }
  for (const markerPath of await listFilesEnding(executionRoot, "")) {
    const marker = await readPrivateJson<ExecutionStartedMarker>(
      agentDir,
      markerPath,
    );
    const pending = pendingByName.get(path.basename(markerPath));
    if (
      marker.version !== 1 ||
      marker.fileName !== path.basename(markerPath) ||
      !pending ||
      marker.auditId !== pending.auditId ||
      marker.storageId !== pending.storageId
    ) {
      throw new Error("self_improve_audit_pending_mismatch");
    }
    normalizeIsoTimestamp(marker.startedAt);
  }
}

async function recoverAuditTemporaryFiles(agentDir: string) {
  for (const root of [
    pendingDir(agentDir),
    executionDir(agentDir),
    acknowledgedDir(agentDir),
  ]) {
    await assertSafeAgentPath(agentDir, root);
    for (const tempPath of await listFilesEnding(root, ".tmp")) {
      await assertSafeAgentPath(agentDir, tempPath);
      await fs.rm(tempPath, { force: true });
      await syncDirectory(path.dirname(tempPath));
    }
  }
  const root = auditsDir(agentDir);
  await assertSafeAgentPath(agentDir, root);
  for (const tempPath of await listFilesEnding(root, ".tmp")) {
    await assertSafeAgentPath(agentDir, tempPath);
    const artifactPath = tempPath.replace(/\.\d+\.[0-9a-f-]+\.tmp$/i, "");
    if (artifactPath === tempPath) {
      await fs.rm(tempPath, { force: true });
      await syncDirectory(path.dirname(tempPath));
      continue;
    }
    let validated:
      | Awaited<ReturnType<typeof readValidatedCompletedArtifact>>
      | undefined;
    try {
      validated = await readValidatedCompletedArtifact(
        agentDir,
        tempPath,
        undefined,
        undefined,
        path.basename(artifactPath),
      );
    } catch (error: any) {
      if (
        !(error instanceof SyntaxError) &&
        error?.message !== "self_improve_audit_pending_mismatch"
      ) {
        throw error;
      }
      await fs.rm(tempPath, { force: true });
      await syncDirectory(path.dirname(tempPath));
      continue;
    }
    const { artifact, artifactBuffer } = validated;
    await assertSafeAgentPath(agentDir, artifactPath);
    if (fssync.existsSync(artifactPath)) {
      const existing = await readValidatedCompletedArtifact(
        agentDir,
        artifactPath,
        artifact.auditId,
        artifact.storageId,
      );
      if (sha256(existing.artifactBuffer) !== sha256(artifactBuffer)) {
        throw new Error("self_improve_audit_pending_mismatch");
      }
    } else {
      await fs.link(tempPath, artifactPath);
      await syncDirectory(path.dirname(artifactPath));
    }
    await fs.rm(tempPath, { force: true });
    await syncDirectory(path.dirname(tempPath));
  }
}

async function findCompletedAuditByStorageId(
  agentDir: string,
  storageId: string,
) {
  let match:
    | {
        filePath: string;
        reference: CompletedSelfImproveRunAudit;
        finishedAt: string;
        policy: SelfImproveRunAuditPolicy;
      }
    | undefined;
  for (const filePath of await listFilesEnding(auditsDir(agentDir), "")) {
    const { artifact } = await readValidatedCompletedArtifact(
      agentDir,
      filePath,
    );
    if (artifact.storageId !== storageId) continue;
    if (match) throw new Error("self_improve_audit_pending_mismatch");
    match = {
      filePath,
      finishedAt: normalizeIsoTimestamp(artifact.finishedAt),
      policy: policyWithDefaults(artifact.policy),
      reference: await completedReference(
        agentDir,
        filePath,
        artifact.auditId,
        storageId,
      ),
    };
  }
  return match;
}

export async function beginSelfImproveRunAudit(input: {
  agentDir: string;
  runId: string;
  kind: string;
  startedAt: string;
  source?: SelfImproveRunAuditSource;
  policy?: Partial<SelfImproveRunAuditPolicy>;
}): Promise<SelfImproveRunAuditHandle> {
  const agentDir = await canonicalAgentRoot(input.agentDir);
  await recoverAuditTemporaryFiles(agentDir);
  await validateAcknowledgedMarkerDirectory(agentDir);
  await validateRecoveryStateDirectories(agentDir);
  const policy = policyWithDefaults(input.policy);
  const startedAt = normalizeIsoTimestamp(input.startedAt);
  const storageId = sha256(
    JSON.stringify({
      runId: input.runId,
      kind: input.kind,
      startedAt,
      source: input.source || null,
    }),
  );
  const runIdMetadata = sanitizeBoundedText(
    input.runId,
    policy.maxMetadataBytes,
  );
  const kindMetadata = sanitizeBoundedText(input.kind, policy.maxMetadataBytes);
  const sourceMetadata = sanitizeSource(input.source, policy.maxMetadataBytes);
  const fileName = `${safeRunFileName(runIdMetadata.text, storageId)}.json`;
  const filePath = path.join(pendingDir(agentDir), fileName);
  const executionStartedPath = path.join(executionDir(agentDir), fileName);
  const acknowledgedPath = path.join(acknowledgedDir(agentDir), fileName);
  await assertSafeAgentPath(agentDir, filePath);
  await assertSafeAgentPath(agentDir, executionStartedPath);
  await assertSafeAgentPath(agentDir, acknowledgedPath);
  const completedMatch = await findCompletedAuditByStorageId(
    agentDir,
    storageId,
  );
  if (completedMatch) {
    let unacknowledged = false;
    if (fssync.existsSync(filePath)) {
      const pending = await readPrivateJson<PendingAudit>(agentDir, filePath);
      validatePendingAudit(
        pending,
        storageId,
        completedMatch.reference.auditId,
        path.basename(filePath),
      );
      if (fssync.existsSync(executionStartedPath)) {
        const marker = await readPrivateJson<ExecutionStartedMarker>(
          agentDir,
          executionStartedPath,
        );
        if (
          marker.version !== 1 ||
          marker.fileName !== path.basename(executionStartedPath) ||
          marker.auditId !== pending.auditId ||
          marker.storageId !== storageId
        ) {
          throw new Error("self_improve_audit_pending_mismatch");
        }
        normalizeIsoTimestamp(marker.startedAt);
      }
      unacknowledged = true;
    }
    const expired =
      Date.now() - Date.parse(completedMatch.finishedAt) >
      completedMatch.policy.maxAgeMs;
    let retentionAcknowledged = false;
    if (expired && fssync.existsSync(acknowledgedPath)) {
      const marker = await readAcknowledgedMarker(
        agentDir,
        acknowledgedPath,
        storageId,
      );
      if (
        marker.status !== completedMatch.reference.status ||
        JSON.stringify(marker.reference) !==
          JSON.stringify(referenceOnly(completedMatch.reference))
      ) {
        throw new Error("self_improve_audit_pending_mismatch");
      }
      retentionAcknowledged = true;
    }
    if (unacknowledged || !expired || !retentionAcknowledged) {
      if (!completedMatch.reference.auditId) {
        throw new Error("self_improve_audit_pending_mismatch");
      }
      return {
        version: 1,
        runId: input.runId,
        auditId: completedMatch.reference.auditId,
        storageId,
        pendingPath: relativeToAgent(agentDir, filePath),
        executionStartedPath: relativeToAgent(agentDir, executionStartedPath),
        completedPath: relativeToAgent(agentDir, completedMatch.filePath),
      };
    }
    await assertSafeAgentPath(agentDir, completedMatch.filePath);
    await fs.rm(completedMatch.filePath, { force: true });
    await syncDirectory(path.dirname(completedMatch.filePath));
  }
  if (fssync.existsSync(acknowledgedPath)) {
    const marker = await readAcknowledgedMarker(
      agentDir,
      acknowledgedPath,
      storageId,
    );
    return {
      version: 1,
      runId: input.runId,
      auditId: marker.auditId,
      storageId,
      pendingPath: relativeToAgent(agentDir, filePath),
      executionStartedPath: relativeToAgent(agentDir, executionStartedPath),
      completedPath: marker.reference.path,
      acknowledged: {
        reference: marker.reference,
        status: marker.status,
      },
    };
  }
  if (fssync.existsSync(filePath)) {
    const pending = await readPrivateJson<PendingAudit>(agentDir, filePath);
    const pendingPolicy = validatePendingAudit(
      pending,
      storageId,
      undefined,
      path.basename(filePath),
    );
    const executionInterrupted = fssync.existsSync(executionStartedPath);
    if (executionInterrupted) {
      const marker = await readPrivateJson<ExecutionStartedMarker>(
        agentDir,
        executionStartedPath,
      );
      if (
        marker.version !== 1 ||
        marker.fileName !== path.basename(executionStartedPath) ||
        marker.auditId !== pending.auditId ||
        marker.storageId !== storageId
      ) {
        throw new Error("self_improve_audit_pending_mismatch");
      }
      normalizeIsoTimestamp(marker.startedAt);
    }
    if (
      executionInterrupted ||
      Date.now() - Date.parse(normalizeIsoTimestamp(pending.startedAt)) <=
        pendingPolicy.maxAgeMs
    ) {
      return {
        version: 1,
        runId: input.runId,
        auditId: pending.auditId,
        storageId,
        pendingPath: relativeToAgent(agentDir, filePath),
        executionStartedPath: relativeToAgent(agentDir, executionStartedPath),
        executionInterrupted,
      };
    }
    await assertSafeAgentPath(agentDir, filePath);
    await fs.rm(filePath, { force: true });
    await syncDirectory(path.dirname(filePath));
  }
  const activePendingFiles: string[] = [];
  const expiredPendingFiles: string[] = [];
  for (const pendingFile of await listFilesEnding(pendingDir(agentDir), "")) {
    const pending = await readPrivateJson<PendingAudit>(agentDir, pendingFile);
    const pendingPolicy = validatePendingAudit(
      pending,
      pending.storageId,
      pending.auditId,
      path.basename(pendingFile),
    );
    const markerPath = path.join(
      executionDir(agentDir),
      path.basename(pendingFile),
    );
    if (fssync.existsSync(markerPath)) {
      const marker = await readPrivateJson<ExecutionStartedMarker>(
        agentDir,
        markerPath,
      );
      if (
        marker.version !== 1 ||
        marker.fileName !== path.basename(markerPath) ||
        marker.auditId !== pending.auditId ||
        marker.storageId !== pending.storageId
      ) {
        throw new Error("self_improve_audit_pending_mismatch");
      }
      normalizeIsoTimestamp(marker.startedAt);
      activePendingFiles.push(pendingFile);
      continue;
    }
    const pendingStartedAt = Date.parse(
      normalizeIsoTimestamp(pending.startedAt),
    );
    if (Date.now() - pendingStartedAt > pendingPolicy.maxAgeMs) {
      expiredPendingFiles.push(pendingFile);
    } else {
      activePendingFiles.push(pendingFile);
    }
  }
  for (const pendingFile of expiredPendingFiles) {
    await assertSafeAgentPath(agentDir, pendingFile);
    await fs.rm(pendingFile, { force: true });
    await syncDirectory(path.dirname(pendingFile));
    const markerPath = path.join(
      executionDir(agentDir),
      path.basename(pendingFile),
    );
    await assertSafeAgentPath(agentDir, markerPath);
    await fs.rm(markerPath, { force: true });
    if (fssync.existsSync(path.dirname(markerPath))) {
      await syncDirectory(path.dirname(markerPath));
    }
  }
  if (activePendingFiles.length > 0) {
    throw new Error("self_improve_audit_pending_capacity");
  }
  const before = await captureSnapshot(agentDir, policy);
  const generationId = crypto.randomUUID();
  const auditId = sha256(
    JSON.stringify({ storageId, generationId, policy, before }),
  );
  const unsignedPending: Omit<PendingAudit, "integritySha256"> = {
    version: 1,
    auditId,
    storageId,
    generationId,
    fileName,
    runId: runIdMetadata.text,
    runIdSha256: sha256(input.runId),
    kind: kindMetadata.text,
    startedAt,
    source: sourceMetadata.source,
    policy,
    metadataRedacted:
      runIdMetadata.redacted ||
      kindMetadata.redacted ||
      sourceMetadata.redacted,
    metadataTruncated:
      runIdMetadata.truncated ||
      kindMetadata.truncated ||
      sourceMetadata.truncated,
    before,
  };
  const pending: PendingAudit = {
    ...unsignedPending,
    integritySha256: pendingIntegritySha256(unsignedPending),
  };
  await writeJsonPrivate(agentDir, filePath, pending, { exclusive: true });
  return {
    version: 1,
    runId: input.runId,
    auditId,
    storageId,
    pendingPath: relativeToAgent(agentDir, filePath),
    executionStartedPath: relativeToAgent(agentDir, executionStartedPath),
  };
}

function mapEntries(snapshot: Snapshot) {
  return new Map(snapshot.entries.map((entry) => [entry.pathSha256, entry]));
}

function buildChanges(
  agentDir: string,
  before: Snapshot,
  after: Snapshot,
  policy: SelfImproveRunAuditPolicy,
) {
  const beforeMap = mapEntries(before);
  const afterMap = mapEntries(after);
  const allPaths = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  let redacted = false;
  let truncated = false;
  let patchBytes = 0;
  const changedFiles: CompletedSelfImproveRunAudit["changedFiles"] = [];
  const changes: any[] = [];
  for (const pathSha256 of [...allPaths].sort()) {
    const oldEntry = beforeMap.get(pathSha256);
    const newEntry = afterMap.get(pathSha256);
    if (oldEntry?.sha256 === newEntry?.sha256) continue;
    const relativePath = newEntry?.path || oldEntry?.path || "[REDACTED]";
    const change = !oldEntry ? "created" : !newEntry ? "deleted" : "updated";
    changedFiles.push({ path: path.join(agentDir, relativePath), change });
    const entry: any = {
      path: relativePath,
      pathSha256,
      change,
      beforeSha256: oldEntry?.sha256,
      afterSha256: newEntry?.sha256,
      beforeBytes: oldEntry?.bytes,
      afterBytes: newEntry?.bytes,
      binary: Boolean(oldEntry?.binary || newEntry?.binary) || undefined,
    };
    const patchUnavailable =
      (oldEntry?.text === undefined && oldEntry !== undefined) ||
      (newEntry?.text === undefined && newEntry !== undefined);
    if (patchUnavailable) {
      entry.patchUnavailable = true;
      entry.patchTruncated = Boolean(
        oldEntry?.truncated || newEntry?.truncated,
      );
      truncated = true;
    } else {
      const patch = createTwoFilesPatch(
        `a/${relativePath}`,
        `b/${relativePath}`,
        oldEntry?.text || "",
        newEntry?.text || "",
        oldEntry?.sha256 || "/dev/null",
        newEntry?.sha256 || "/dev/null",
      );
      const remainingPatchBytes = Math.max(
        0,
        policy.maxPatchBytes - patchBytes,
      );
      if (remainingPatchBytes === 0) {
        entry.patch = "";
        entry.patchTruncated = true;
        truncated = true;
      } else {
        const bounded = truncateUtf8(patch, remainingPatchBytes);
        entry.patch = bounded.text;
        entry.patchTruncated = bounded.truncated || undefined;
        patchBytes += Buffer.byteLength(bounded.text, "utf8");
        truncated ||= bounded.truncated;
      }
    }
    entry.redacted =
      Boolean(oldEntry?.redacted || newEntry?.redacted) || undefined;
    redacted ||= Boolean(entry.redacted);
    changes.push(entry);
  }
  return { changes, changedFiles, redacted, truncated };
}

async function listFilesEnding(
  root: string,
  suffix: string,
): Promise<string[]> {
  if (!fssync.existsSync(root)) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("self_improve_audit_symlink_path");
    }
    if (entry.isDirectory()) {
      files.push(...(await listFilesEnding(fullPath, suffix)));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      files.push(fullPath);
    }
  }
  return files;
}

async function pruneRunAudits(
  agentDir: string,
  _policy: SelfImproveRunAuditPolicy,
  nowMs: number,
  preservePath?: string,
) {
  const root = auditsDir(agentDir);
  const protectedPaths = new Set<string>();
  if (preservePath) protectedPaths.add(path.resolve(preservePath));
  await assertSafeAgentPath(agentDir, root);

  const pendingRoot = pendingDir(agentDir);
  const executionRoot = executionDir(agentDir);
  await assertSafeAgentPath(agentDir, pendingRoot);
  await assertSafeAgentPath(agentDir, executionRoot);
  const pendingRows: Array<{
    filePath: string;
    startedAt: number;
    maxAgeMs: number;
    completedPath: string;
    executionStarted: boolean;
  }> = [];
  for (const filePath of await listFilesEnding(pendingRoot, "")) {
    const pending = await readPrivateJson<PendingAudit>(agentDir, filePath);
    const pendingPolicy = validatePendingAudit(
      pending,
      pending.storageId,
      pending.auditId,
      path.basename(filePath),
    );
    const completedPath = path.resolve(
      completedAuditPath(
        agentDir,
        pending.startedAt,
        pending.runId,
        pending.auditId,
      ),
    );
    const markerPath = path.join(executionRoot, path.basename(filePath));
    const executionStarted = fssync.existsSync(markerPath);
    if (executionStarted) {
      const marker = await readPrivateJson<ExecutionStartedMarker>(
        agentDir,
        markerPath,
      );
      if (
        marker.version !== 1 ||
        marker.fileName !== path.basename(markerPath) ||
        marker.auditId !== pending.auditId ||
        marker.storageId !== pending.storageId
      ) {
        throw new Error("self_improve_audit_pending_mismatch");
      }
      normalizeIsoTimestamp(marker.startedAt);
    }
    pendingRows.push({
      filePath,
      startedAt: Date.parse(normalizeIsoTimestamp(pending.startedAt)),
      maxAgeMs: pendingPolicy.maxAgeMs,
      completedPath,
      executionStarted,
    });
  }
  pendingRows.sort(
    (a, b) => b.startedAt - a.startedAt || b.filePath.localeCompare(a.filePath),
  );
  const preservedPendingPath = preservePath
    ? path.resolve(preservePath)
    : undefined;
  const pendingRemovals: string[] = [];
  for (const row of pendingRows) {
    if (row.completedPath === preservedPendingPath || row.executionStarted) {
      protectedPaths.add(row.completedPath);
      continue;
    }
    if (nowMs - row.startedAt > row.maxAgeMs) {
      pendingRemovals.push(row.filePath);
      continue;
    }
    protectedPaths.add(row.completedPath);
  }

  const acknowledgedRoot = acknowledgedDir(agentDir);
  await assertSafeAgentPath(agentDir, acknowledgedRoot);
  const acknowledged = new Map<string, AcknowledgedAuditMarker>();
  for (const markerPath of await listFilesEnding(acknowledgedRoot, "")) {
    const raw = await readJson<AcknowledgedAuditMarker>(markerPath);
    const marker = await readAcknowledgedMarker(
      agentDir,
      markerPath,
      raw.storageId,
    );
    if (acknowledged.has(marker.storageId)) {
      throw new Error("self_improve_audit_pending_mismatch");
    }
    acknowledged.set(marker.storageId, marker);
  }

  const rows: Array<{
    filePath: string;
    finishedAt: number;
    maxAgeMs: number;
    maxArtifacts: number;
    retentionAcknowledged: boolean;
  }> = [];
  for (const filePath of await listFilesEnding(root, "")) {
    const { artifact } = await readValidatedCompletedArtifact(
      agentDir,
      filePath,
    );
    const artifactPolicy = policyWithDefaults(artifact.policy);
    const reference = await completedReference(
      agentDir,
      filePath,
      artifact.auditId,
      artifact.storageId,
    );
    const marker = acknowledged.get(artifact.storageId);
    if (
      marker &&
      (marker.status !== reference.status ||
        JSON.stringify(marker.reference) !==
          JSON.stringify(referenceOnly(reference)))
    ) {
      throw new Error("self_improve_audit_pending_mismatch");
    }
    rows.push({
      filePath,
      finishedAt: Date.parse(normalizeIsoTimestamp(artifact.finishedAt)),
      maxAgeMs: artifactPolicy.maxAgeMs,
      maxArtifacts: artifactPolicy.maxArtifacts,
      retentionAcknowledged: Boolean(marker),
    });
  }
  rows.sort(
    (a, b) =>
      b.finishedAt - a.finishedAt || b.filePath.localeCompare(a.filePath),
  );

  const removals: string[] = [];
  for (const [index, row] of rows.entries()) {
    if (protectedPaths.has(path.resolve(row.filePath))) continue;
    if (
      row.retentionAcknowledged &&
      (nowMs - row.finishedAt > row.maxAgeMs || index >= row.maxArtifacts)
    ) {
      removals.push(row.filePath);
    }
  }
  for (const filePath of [...removals, ...pendingRemovals]) {
    await assertSafeAgentPath(agentDir, filePath);
    await fs.rm(filePath, { force: true });
    await syncDirectory(path.dirname(filePath));
  }
}

async function readValidatedCompletedArtifact(
  agentDir: string,
  artifactPath: string,
  expectedAuditId?: string,
  expectedStorageId?: string,
  expectedFileName = path.basename(artifactPath),
) {
  await assertSafeAgentPath(agentDir, artifactPath);
  const stat = await fs.lstat(artifactPath);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("self_improve_audit_pending_mismatch");
  }
  const artifactBuffer = await fs.readFile(artifactPath);
  const artifactText = artifactBuffer.toString("utf8");
  const artifact = JSON.parse(artifactText) as any;
  const { integritySha256, ...unsignedArtifact } = artifact;
  if (
    artifactText !== `${JSON.stringify(artifact, null, 2)}\n` ||
    artifact.version !== 1 ||
    artifact.fileName !== expectedFileName ||
    !integritySha256 ||
    integritySha256 !== recordIntegritySha256(unsignedArtifact) ||
    (expectedAuditId !== undefined && artifact.auditId !== expectedAuditId) ||
    (expectedStorageId !== undefined &&
      artifact.storageId !== expectedStorageId)
  ) {
    throw new Error("self_improve_audit_pending_mismatch");
  }
  normalizeIsoTimestamp(artifact.finishedAt);
  return { artifact, artifactBuffer };
}

async function completedReference(
  agentDir: string,
  artifactPath: string,
  expectedAuditId?: string,
  expectedStorageId?: string,
): Promise<CompletedSelfImproveRunAudit> {
  const { artifact, artifactBuffer } = await readValidatedCompletedArtifact(
    agentDir,
    artifactPath,
    expectedAuditId,
    expectedStorageId,
  );
  return {
    version: 1,
    auditId: artifact.auditId,
    path: relativeToAgent(agentDir, artifactPath),
    sha256: sha256(artifactBuffer),
    status: artifact.status,
    output: artifact.output?.text || undefined,
    error: artifact.error?.text || undefined,
    complete: artifact.complete === true,
    redacted: artifact.redacted === true,
    truncated: artifact.truncated === true,
    changedFiles: Array.isArray(artifact.changes)
      ? artifact.changes.map((entry: any) => ({
          path: path.join(agentDir, String(entry.path || "[REDACTED]")),
          change: entry.change,
        }))
      : [],
  };
}

export async function markSelfImproveRunAuditExecutionStarted(input: {
  agentDir: string;
  handle: SelfImproveRunAuditHandle;
  startedAt?: string;
}) {
  if (input.handle.completedPath || input.handle.executionInterrupted) {
    throw new Error("self_improve_audit_pending_mismatch");
  }
  const agentDir = await canonicalAgentRoot(input.agentDir);
  const pendingPath = path.resolve(agentDir, input.handle.pendingPath);
  const markerPath = path.resolve(agentDir, input.handle.executionStartedPath);
  await assertSafeAgentPath(agentDir, pendingPath);
  await assertSafeAgentPath(agentDir, markerPath);
  const pending = await readPrivateJson<PendingAudit>(agentDir, pendingPath);
  validatePendingAudit(
    pending,
    input.handle.storageId,
    input.handle.auditId,
    path.basename(pendingPath),
  );
  const marker: ExecutionStartedMarker = {
    version: 1,
    auditId: input.handle.auditId,
    storageId: input.handle.storageId,
    fileName: path.basename(markerPath),
    startedAt: normalizeIsoTimestamp(
      input.startedAt || new Date().toISOString(),
    ),
  };
  await writeJsonPrivate(agentDir, markerPath, marker, { exclusive: true });
}

export async function completeSelfImproveRunAudit(input: {
  agentDir: string;
  handle: SelfImproveRunAuditHandle;
  status: "completed" | "failed" | "skipped";
  finishedAt: string;
  output?: string;
  error?: string;
  nowMs?: number;
}): Promise<CompletedSelfImproveRunAudit> {
  const agentDir = await canonicalAgentRoot(input.agentDir);
  const finishedAt = normalizeIsoTimestamp(input.finishedAt);
  if (input.handle.acknowledged) {
    return {
      ...input.handle.acknowledged.reference,
      status: input.handle.acknowledged.status,
      evidenceRetained: false,
      output: "",
      error:
        input.handle.acknowledged.status === "failed"
          ? "self_improve_audit_acknowledged_evidence_expired"
          : undefined,
      changedFiles: [],
    };
  }
  if (input.handle.completedPath) {
    const completedPath = path.resolve(agentDir, input.handle.completedPath);
    if (!completedPath.startsWith(`${agentDir}${path.sep}`)) {
      throw new Error("self_improve_audit_pending_path_outside_agent_dir");
    }
    await assertSafeAgentPath(agentDir, completedPath);
    const { artifact } = await readValidatedCompletedArtifact(
      agentDir,
      completedPath,
      input.handle.auditId,
      input.handle.storageId,
    );
    const reference = await completedReference(
      agentDir,
      completedPath,
      input.handle.auditId,
      input.handle.storageId,
    );
    await pruneRunAudits(
      agentDir,
      policyWithDefaults(artifact.policy),
      input.nowMs ?? Date.now(),
      completedPath,
    );
    return reference;
  }

  const pendingPath = path.resolve(agentDir, input.handle.pendingPath);
  if (!pendingPath.startsWith(`${agentDir}${path.sep}`)) {
    throw new Error("self_improve_audit_pending_path_outside_agent_dir");
  }
  await assertSafeAgentPath(agentDir, pendingPath);
  const pending = await readPrivateJson<PendingAudit>(agentDir, pendingPath);
  const pendingPolicy = validatePendingAudit(
    pending,
    input.handle.storageId,
    input.handle.auditId,
    path.basename(pendingPath),
  );
  const artifactPath = completedAuditPath(
    agentDir,
    pending.startedAt,
    pending.runId,
    pending.auditId,
  );
  if (fssync.existsSync(artifactPath)) {
    const reference = await completedReference(
      agentDir,
      artifactPath,
      pending.auditId,
      pending.storageId,
    );
    await pruneRunAudits(
      agentDir,
      pendingPolicy,
      input.nowMs ?? Date.now(),
      artifactPath,
    );
    return reference;
  }
  const after = await captureSnapshot(agentDir, pendingPolicy);
  const changeResult = buildChanges(
    agentDir,
    pending.before,
    after,
    pendingPolicy,
  );
  const rawOutput = String(input.output || "");
  const sanitizedOutput = sanitizeBoundedText(
    rawOutput,
    pendingPolicy.maxOutputBytes,
  );
  const rawError = String(input.error || "");
  const sanitizedError = sanitizeBoundedText(
    rawError,
    pendingPolicy.maxErrorBytes,
  );
  const redacted =
    pending.metadataRedacted ||
    pending.before.redacted ||
    after.redacted ||
    changeResult.redacted ||
    sanitizedOutput.redacted ||
    sanitizedError.redacted;
  const truncated =
    pending.metadataTruncated ||
    pending.before.truncated ||
    after.truncated ||
    changeResult.truncated ||
    sanitizedOutput.truncated ||
    sanitizedError.truncated;
  const unsignedArtifact = {
    version: 1,
    auditId: pending.auditId,
    storageId: pending.storageId,
    fileName: path.basename(artifactPath),
    runId: pending.runId,
    runIdSha256: pending.runIdSha256,
    kind: pending.kind,
    startedAt: pending.startedAt,
    finishedAt,
    status: input.status,
    source: pending.source,
    policy: pendingPolicy,
    beforeRootSha256: pending.before.rootSha256,
    afterRootSha256: after.rootSha256,
    complete: !truncated && !redacted,
    redacted,
    truncated,
    output: {
      sha256: sha256(rawOutput),
      bytes: Buffer.byteLength(rawOutput, "utf8"),
      text: sanitizedOutput.text,
      redacted: sanitizedOutput.redacted,
      truncated: sanitizedOutput.truncated,
    },
    error: input.error
      ? {
          sha256: sha256(rawError),
          bytes: Buffer.byteLength(rawError, "utf8"),
          text: sanitizedError.text,
          redacted: sanitizedError.redacted,
          truncated: sanitizedError.truncated,
        }
      : undefined,
    changes: changeResult.changes,
  };
  const artifact = {
    ...unsignedArtifact,
    integritySha256: recordIntegritySha256(unsignedArtifact),
  };
  await writeJsonPrivate(agentDir, artifactPath, artifact, {
    exclusive: true,
    preserveTempOnFailure: true,
  });
  const reference = await completedReference(
    agentDir,
    artifactPath,
    pending.auditId,
    pending.storageId,
  );
  await pruneRunAudits(
    agentDir,
    pendingPolicy,
    input.nowMs ?? Date.now(),
    artifactPath,
  );
  return reference;
}

export async function acknowledgeSelfImproveRunAudit(input: {
  agentDir: string;
  handle: SelfImproveRunAuditHandle;
  reference: SelfImproveRunAuditReference;
}) {
  const agentDir = await canonicalAgentRoot(input.agentDir);
  const pendingPath = path.resolve(agentDir, input.handle.pendingPath);
  const executionStartedPath = path.resolve(
    agentDir,
    input.handle.executionStartedPath,
  );
  if (!pendingPath.startsWith(`${agentDir}${path.sep}`)) {
    throw new Error("self_improve_audit_pending_path_outside_agent_dir");
  }
  const artifactPath = path.resolve(agentDir, input.reference.path);
  if (!artifactPath.startsWith(`${agentDir}${path.sep}`)) {
    throw new Error("self_improve_audit_pending_path_outside_agent_dir");
  }
  const acknowledgedPath = path.join(
    acknowledgedDir(agentDir),
    path.basename(pendingPath),
  );
  await assertSafeAgentPath(agentDir, acknowledgedPath);
  const expectedReference = referenceOnly(input.reference);
  if (fssync.existsSync(acknowledgedPath)) {
    const marker = await readAcknowledgedMarker(
      agentDir,
      acknowledgedPath,
      input.handle.storageId,
    );
    if (
      marker.auditId !== input.handle.auditId ||
      JSON.stringify(marker.reference) !== JSON.stringify(expectedReference)
    ) {
      throw new Error("self_improve_audit_pending_mismatch");
    }
  } else {
    const reference = await completedReference(
      agentDir,
      artifactPath,
      input.handle.auditId,
      input.handle.storageId,
    );
    if (reference.sha256 !== input.reference.sha256) {
      throw new Error("self_improve_audit_pending_mismatch");
    }
    const unsignedMarker: Omit<AcknowledgedAuditMarker, "integritySha256"> = {
      version: 1,
      storageId: input.handle.storageId,
      auditId: input.handle.auditId,
      fileName: path.basename(acknowledgedPath),
      reference: expectedReference,
      status: reference.status === "failed" ? "failed" : "completed",
    };
    await writeJsonPrivate(
      agentDir,
      acknowledgedPath,
      {
        ...unsignedMarker,
        integritySha256: recordIntegritySha256(unsignedMarker),
      },
      { exclusive: true },
    );
  }
  if (fssync.existsSync(pendingPath)) {
    const pending = await readPrivateJson<PendingAudit>(agentDir, pendingPath);
    validatePendingAudit(
      pending,
      input.handle.storageId,
      input.handle.auditId,
      path.basename(pendingPath),
    );
  }
  await assertSafeAgentPath(agentDir, pendingPath);
  await assertSafeAgentPath(agentDir, executionStartedPath);
  await fs.rm(executionStartedPath, { force: true });
  if (fssync.existsSync(path.dirname(executionStartedPath))) {
    await syncDirectory(path.dirname(executionStartedPath));
  }
  await fs.rm(pendingPath, { force: true });
  await syncDirectory(path.dirname(pendingPath));
}

export async function verifySelfImproveRunAudit(
  agentDir: string,
  reference: SelfImproveRunAuditReference,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const root = await canonicalAgentRoot(agentDir);
  const filePath = path.resolve(root, reference.path);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    return { ok: false, error: "path_outside_agent_dir" };
  }
  try {
    await assertSafeAgentPath(root, filePath);
    const buffer = await fs.readFile(filePath);
    if (sha256(buffer) !== reference.sha256) {
      return { ok: false, error: "sha256_mismatch" };
    }
    const actual = await completedReference(root, filePath, reference.auditId);
    if (actual.sha256 !== reference.sha256) {
      return { ok: false, error: "sha256_mismatch" };
    }
    if (
      reference.version !== actual.version ||
      reference.complete !== actual.complete ||
      reference.redacted !== actual.redacted ||
      reference.truncated !== actual.truncated
    ) {
      return { ok: false, error: "reference_metadata_mismatch" };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
