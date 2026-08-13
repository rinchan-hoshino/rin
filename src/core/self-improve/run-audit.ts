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
  trigger?: string;
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

export type SelfImproveRunAuditCapture = {
  version: 1;
  agentRoot: string;
  auditId: string;
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
    return { source: undefined, redacted: false, truncated: false };
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
      trigger: bounded(source.trigger),
    },
    redacted,
    truncated,
  };
}

async function canonicalAgentRoot(agentDir: string) {
  return await fs.realpath(path.resolve(agentDir));
}

async function assertSafeAgentPath(agentDir: string, targetPath: string) {
  const root = path.resolve(agentDir);
  const target = path.resolve(targetPath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("self_improve_audit_path_outside_agent_dir");
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
    throw new Error("self_improve_audit_path_outside_agent_dir");
  }
  const root = await canonicalAgentRoot(lexicalRoot);
  const target = path.resolve(root, path.relative(lexicalRoot, lexicalTarget));
  await assertSafeAgentPath(root, target);
  return target;
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

function auditsDir(agentDir: string) {
  return path.join(selfImproveStateDir(agentDir), "run-audits");
}

function relativeToAgent(agentDir: string, filePath: string) {
  return path
    .relative(path.resolve(agentDir), filePath)
    .split(path.sep)
    .join("/");
}

function safeRunFileName(runId: string, auditId: string) {
  const readable =
    runId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 96) || "run";
  return `${readable}-${auditId}`;
}

function completedAuditPath(
  agentDir: string,
  startedAt: string,
  runId: string,
  auditId: string,
) {
  const date = normalizeIsoTimestamp(startedAt).slice(0, 10);
  return path.join(
    auditsDir(agentDir),
    date,
    `${safeRunFileName(runId, auditId)}.json`,
  );
}

async function syncDirectory(dirPath: string) {
  const handle = await fs.open(dirPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonPrivateAtomic(
  agentDir: string,
  filePath: string,
  value: unknown,
) {
  await assertSafeAgentPath(agentDir, filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await assertSafeAgentPath(agentDir, filePath);
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.link(tempPath, filePath);
    await fs.rm(tempPath);
    await syncDirectory(path.dirname(filePath));
  } finally {
    await fs.rm(tempPath, { force: true });
  }
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
      const bounded = truncateUtf8(patch, remainingPatchBytes);
      entry.patch = bounded.text;
      entry.patchTruncated = bounded.truncated || undefined;
      patchBytes += Buffer.byteLength(bounded.text, "utf8");
      truncated ||= bounded.truncated;
    }
    entry.redacted =
      Boolean(oldEntry?.redacted || newEntry?.redacted) || undefined;
    redacted ||= Boolean(entry.redacted);
    changes.push(entry);
  }
  return { changes, changedFiles, redacted, truncated };
}

function recordIntegritySha256(record: object) {
  return sha256(JSON.stringify(record));
}

async function listArtifactFiles(root: string): Promise<string[]> {
  if (!fssync.existsSync(root)) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("self_improve_audit_symlink_path");
    }
    if (entry.isDirectory()) files.push(...(await listArtifactFiles(fullPath)));
    else if (entry.isFile() && entry.name.endsWith(".json"))
      files.push(fullPath);
  }
  return files;
}

async function readValidatedCompletedArtifact(
  agentDir: string,
  artifactPath: string,
  expectedAuditId?: string,
) {
  await assertSafeAgentPath(agentDir, artifactPath);
  const stat = await fs.lstat(artifactPath);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("self_improve_audit_artifact_invalid");
  }
  const artifactBuffer = await fs.readFile(artifactPath);
  const artifactText = artifactBuffer.toString("utf8");
  const artifact = JSON.parse(artifactText) as any;
  const { integritySha256, ...unsignedArtifact } = artifact;
  if (
    artifactText !== `${JSON.stringify(artifact, null, 2)}\n` ||
    artifact.version !== 1 ||
    artifact.fileName !== path.basename(artifactPath) ||
    !integritySha256 ||
    integritySha256 !== recordIntegritySha256(unsignedArtifact) ||
    (expectedAuditId !== undefined && artifact.auditId !== expectedAuditId)
  ) {
    throw new Error("self_improve_audit_artifact_invalid");
  }
  normalizeIsoTimestamp(artifact.finishedAt);
  return { artifact, artifactBuffer };
}

async function completedReference(
  agentDir: string,
  artifactPath: string,
  expectedAuditId?: string,
): Promise<CompletedSelfImproveRunAudit> {
  const { artifact, artifactBuffer } = await readValidatedCompletedArtifact(
    agentDir,
    artifactPath,
    expectedAuditId,
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

async function pruneRunAudits(
  agentDir: string,
  policy: SelfImproveRunAuditPolicy,
  nowMs: number,
  preservePath: string,
) {
  const root = auditsDir(agentDir);
  await assertSafeAgentPath(agentDir, root);
  const rows: Array<{ filePath: string; finishedAt: number }> = [];
  for (const filePath of await listArtifactFiles(root)) {
    const { artifact } = await readValidatedCompletedArtifact(
      agentDir,
      filePath,
    );
    rows.push({
      filePath,
      finishedAt: Date.parse(normalizeIsoTimestamp(artifact.finishedAt)),
    });
  }
  rows.sort(
    (a, b) =>
      b.finishedAt - a.finishedAt || b.filePath.localeCompare(a.filePath),
  );
  let retained = 0;
  for (const row of rows) {
    const current = path.resolve(row.filePath) === path.resolve(preservePath);
    if (
      current ||
      (retained < policy.maxArtifacts &&
        nowMs - row.finishedAt <= policy.maxAgeMs)
    ) {
      retained += 1;
      continue;
    }
    await fs.rm(row.filePath, { force: true });
  }
}

export async function beginSelfImproveRunAudit(input: {
  agentDir: string;
  runId: string;
  kind: string;
  startedAt: string;
  source?: SelfImproveRunAuditSource;
  policy?: Partial<SelfImproveRunAuditPolicy>;
}): Promise<SelfImproveRunAuditCapture> {
  const agentRoot = await canonicalAgentRoot(input.agentDir);
  const policy = policyWithDefaults(input.policy);
  const startedAt = normalizeIsoTimestamp(input.startedAt);
  const runId = sanitizeBoundedText(input.runId, policy.maxMetadataBytes);
  const kind = sanitizeBoundedText(input.kind, policy.maxMetadataBytes);
  const source = sanitizeSource(input.source, policy.maxMetadataBytes);
  const before = await captureSnapshot(agentRoot, policy);
  const auditId = sha256(
    JSON.stringify({
      runId: input.runId,
      kind: input.kind,
      startedAt,
      source: input.source || null,
      generationId: crypto.randomUUID(),
      beforeRootSha256: before.rootSha256,
    }),
  );
  return {
    version: 1,
    agentRoot,
    auditId,
    runId: runId.text,
    runIdSha256: sha256(input.runId),
    kind: kind.text,
    startedAt,
    source: source.source,
    policy,
    metadataRedacted: runId.redacted || kind.redacted || source.redacted,
    metadataTruncated: runId.truncated || kind.truncated || source.truncated,
    before,
  };
}

export async function completeSelfImproveRunAudit(input: {
  agentDir: string;
  capture: SelfImproveRunAuditCapture;
  status: "completed" | "failed" | "skipped";
  finishedAt: string;
  output?: string;
  error?: string;
  nowMs?: number;
}): Promise<CompletedSelfImproveRunAudit> {
  const agentRoot = await canonicalAgentRoot(input.agentDir);
  if (input.capture.version !== 1 || input.capture.agentRoot !== agentRoot) {
    throw new Error("self_improve_audit_capture_mismatch");
  }
  const finishedAt = normalizeIsoTimestamp(input.finishedAt);
  const after = await captureSnapshot(agentRoot, input.capture.policy);
  const changeResult = buildChanges(
    agentRoot,
    input.capture.before,
    after,
    input.capture.policy,
  );
  const rawOutput = String(input.output || "");
  const output = sanitizeBoundedText(
    rawOutput,
    input.capture.policy.maxOutputBytes,
  );
  const rawError = String(input.error || "");
  const error = sanitizeBoundedText(
    rawError,
    input.capture.policy.maxErrorBytes,
  );
  const redacted =
    input.capture.metadataRedacted ||
    input.capture.before.redacted ||
    after.redacted ||
    changeResult.redacted ||
    output.redacted ||
    error.redacted;
  const truncated =
    input.capture.metadataTruncated ||
    input.capture.before.truncated ||
    after.truncated ||
    changeResult.truncated ||
    output.truncated ||
    error.truncated;
  const artifactPath = completedAuditPath(
    agentRoot,
    input.capture.startedAt,
    input.capture.runId,
    input.capture.auditId,
  );
  const unsignedArtifact = {
    version: 1,
    auditId: input.capture.auditId,
    fileName: path.basename(artifactPath),
    runId: input.capture.runId,
    runIdSha256: input.capture.runIdSha256,
    kind: input.capture.kind,
    startedAt: input.capture.startedAt,
    finishedAt,
    status: input.status,
    source: input.capture.source,
    policy: input.capture.policy,
    beforeRootSha256: input.capture.before.rootSha256,
    afterRootSha256: after.rootSha256,
    complete: !truncated && !redacted,
    redacted,
    truncated,
    output: {
      sha256: sha256(rawOutput),
      bytes: Buffer.byteLength(rawOutput, "utf8"),
      text: output.text,
      redacted: output.redacted,
      truncated: output.truncated,
    },
    error: input.error
      ? {
          sha256: sha256(rawError),
          bytes: Buffer.byteLength(rawError, "utf8"),
          text: error.text,
          redacted: error.redacted,
          truncated: error.truncated,
        }
      : undefined,
    changes: changeResult.changes,
  };
  const artifact = {
    ...unsignedArtifact,
    integritySha256: recordIntegritySha256(unsignedArtifact),
  };
  await writeJsonPrivateAtomic(agentRoot, artifactPath, artifact);
  const reference = await completedReference(
    agentRoot,
    artifactPath,
    input.capture.auditId,
  );
  await pruneRunAudits(
    agentRoot,
    input.capture.policy,
    input.nowMs ?? Date.now(),
    artifactPath,
  );
  return reference;
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
    if (
      actual.sha256 !== reference.sha256 ||
      reference.version !== actual.version ||
      reference.complete !== actual.complete ||
      reference.redacted !== actual.redacted ||
      reference.truncated !== actual.truncated
    ) {
      return { ok: false, error: "reference_metadata_mismatch" };
    }
    return { ok: true };
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return { ok: false, error: "artifact_unavailable" };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
