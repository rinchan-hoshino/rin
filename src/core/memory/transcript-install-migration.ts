import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  collectTranscriptFiles,
  extractTranscriptMedia,
  extractTranscriptText,
  isLegacySyntheticSessionSummaryEntry,
  iterateLfDelimitedTextFile,
} from "./transcript-archive.js";
import type { TranscriptArchiveEntry } from "./transcript-types.js";
import { safeString } from "./utils.js";

export type TranscriptArchiveMigrationIssue = {
  line: number;
  bytes: number;
  sha256: string;
  classification: "confirmed-interleaved" | "unknown-corruption";
};

export type TranscriptArchiveMigrationFile = {
  relativePath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  writtenSize: number;
  writtenEntries: number;
  filteredEntries: number;
  issues: TranscriptArchiveMigrationIssue[];
};

export type TranscriptArchiveMigrationManifest = {
  version: 1;
  files: TranscriptArchiveMigrationFile[];
  summary: {
    sourceFiles: number;
    sourceBytes: number;
    writtenBytes: number;
    writtenEntries: number;
    filteredEntries: number;
    confirmedCorruptLines: number;
    confirmedCorruptBytes: number;
    unknownCorruptLines: number;
  };
};

export type TranscriptArchiveMigrationOptions = {
  quarantineRoot?: string;
};

function optionalString(value: unknown): string | undefined {
  return safeString(value || "").trim() || undefined;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function recordStartCount(rawLine: string): number {
  let count = 0;
  let offset = 0;
  const needle = '{"id":"';
  while (true) {
    const index = rawLine.indexOf(needle, offset);
    if (index < 0) return count;
    const timestampIndex = rawLine.indexOf(
      '","timestamp":',
      index + needle.length,
    );
    if (timestampIndex >= 0 && timestampIndex - index < 512) count += 1;
    offset = index + needle.length;
  }
}

export function isConfirmedInterleavedTranscriptLine(rawLine: string): boolean {
  const interleavedRecordHeads =
    recordStartCount(rawLine) > 1 &&
    rawLine.includes('"content":') &&
    rawLine.includes('"data":"');
  const trimmed = rawLine.trimStart();
  const startsWithBase64Continuation =
    !trimmed.startsWith("{") && /^[A-Za-z0-9+/]{64}/.test(trimmed);
  const orphanedImageTail =
    startsWithBase64Continuation &&
    /","mimeType":"image\/[^"]+"}\]/.test(trimmed) &&
    /}\s*$/.test(trimmed);
  const prefixedInterleavedRecord =
    startsWithBase64Continuation &&
    recordStartCount(trimmed) >= 1 &&
    trimmed.includes('"content":') &&
    /}\s*$/.test(trimmed);
  return (
    interleavedRecordHeads || orphanedImageTail || prefixedInterleavedRecord
  );
}

export function sanitizeTranscriptArchiveEntryForMigration(
  input: Record<string, unknown>,
): TranscriptArchiveEntry | null {
  if (isLegacySyntheticSessionSummaryEntry(input)) return null;
  const text =
    safeString(input.text || "").trim() || extractTranscriptText(input);
  if (!text) return null;
  const media = extractTranscriptMedia(input);
  const toolName = optionalString(input.toolName);
  const toolCallId = optionalString(input.toolCallId);
  const customType = optionalString(input.customType);
  const stopReason = optionalString(input.stopReason);
  const errorMessage = optionalString(input.errorMessage);
  const provider = optionalString(input.provider);
  const model = optionalString(input.model);
  return {
    id: safeString(input.id || "").trim(),
    timestamp: safeString(input.timestamp || "").trim(),
    sessionId: safeString(input.sessionId || "").trim(),
    sessionFile: safeString(input.sessionFile || "").trim(),
    role: safeString(input.role || "").trim(),
    text,
    ...(media.length ? { media } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(customType ? { customType } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(typeof input.display === "boolean" ? { display: input.display } : {}),
  };
}

function safeTargetPath(targetRoot: string, relativePath: string): string {
  const resolvedRoot = path.resolve(targetRoot);
  const targetPath = path.resolve(resolvedRoot, relativePath);
  if (
    targetPath !== resolvedRoot &&
    !targetPath.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error("transcript_archive_install_target_path_invalid");
  }
  return targetPath;
}

async function quarantineUnknownTranscriptLine(
  quarantineRoot: string,
  relativePath: string,
  rawLine: string,
  issue: TranscriptArchiveMigrationIssue,
) {
  await fs.mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
  const occurrenceId = sha256(
    `${relativePath}\0${issue.line}\0${issue.sha256}`,
  );
  const fragmentPath = path.join(
    quarantineRoot,
    `${occurrenceId}.jsonl-fragment`,
  );
  const metadataPath = path.join(quarantineRoot, `${occurrenceId}.json`);
  await fs.writeFile(fragmentPath, `${rawLine}\n`, { mode: 0o600 });
  await fs.writeFile(
    metadataPath,
    `${JSON.stringify({ version: 1, relativePath, ...issue }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function sanitizeTranscriptArchiveFile(
  sourcePath: string,
  targetPath: string,
  relativePath: string,
  quarantineRoot: string,
): Promise<TranscriptArchiveMigrationFile> {
  const sourceStat = await fs.stat(sourcePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const output = await fs.open(targetPath, "w", 0o600);
  const issues: TranscriptArchiveMigrationIssue[] = [];
  let writtenEntries = 0;
  let filteredEntries = 0;
  try {
    for await (const { line, lineNumber } of iterateLfDelimitedTextFile(
      sourcePath,
    )) {
      const sourceLine = line;
      const rawLine = sourceLine.trim();
      if (!rawLine) continue;
      let parsed: unknown;
      let classification:
        | TranscriptArchiveMigrationIssue["classification"]
        | null = null;
      try {
        parsed = JSON.parse(rawLine);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          classification = "unknown-corruption";
        }
      } catch {
        classification = isConfirmedInterleavedTranscriptLine(rawLine)
          ? "confirmed-interleaved"
          : "unknown-corruption";
      }
      if (classification) {
        const issue: TranscriptArchiveMigrationIssue = {
          line: lineNumber,
          bytes: Buffer.byteLength(sourceLine),
          sha256: sha256(sourceLine),
          classification,
        };
        issues.push(issue);
        if (classification === "unknown-corruption") {
          await quarantineUnknownTranscriptLine(
            quarantineRoot,
            relativePath,
            sourceLine,
            issue,
          );
          throw new Error(
            `transcript_archive_install_unknown_corruption:${relativePath}:${lineNumber}`,
          );
        }
        continue;
      }
      const sanitized = sanitizeTranscriptArchiveEntryForMigration(
        parsed as Record<string, unknown>,
      );
      if (!sanitized) {
        filteredEntries += 1;
        continue;
      }
      await output.write(`${JSON.stringify(sanitized)}\n`, undefined, "utf8");
      writtenEntries += 1;
    }
    await output.sync();
  } finally {
    await output.close();
  }
  const writtenStat = await fs.stat(targetPath);
  return {
    relativePath,
    sourceSize: sourceStat.size,
    sourceMtimeMs: Math.trunc(sourceStat.mtimeMs),
    writtenSize: writtenStat.size,
    writtenEntries,
    filteredEntries,
    issues,
  };
}

function buildManifest(
  files: TranscriptArchiveMigrationFile[],
): TranscriptArchiveMigrationManifest {
  return {
    version: 1,
    files,
    summary: {
      sourceFiles: files.length,
      sourceBytes: files.reduce((sum, file) => sum + file.sourceSize, 0),
      writtenBytes: files.reduce((sum, file) => sum + file.writtenSize, 0),
      writtenEntries: files.reduce((sum, file) => sum + file.writtenEntries, 0),
      filteredEntries: files.reduce(
        (sum, file) => sum + file.filteredEntries,
        0,
      ),
      confirmedCorruptLines: files.reduce(
        (sum, file) =>
          sum +
          file.issues.filter(
            (issue) => issue.classification === "confirmed-interleaved",
          ).length,
        0,
      ),
      confirmedCorruptBytes: files.reduce(
        (sum, file) =>
          sum +
          file.issues
            .filter((issue) => issue.classification === "confirmed-interleaved")
            .reduce((inner, issue) => inner + issue.bytes, 0),
        0,
      ),
      unknownCorruptLines: files.reduce(
        (sum, file) =>
          sum +
          file.issues.filter(
            (issue) => issue.classification === "unknown-corruption",
          ).length,
        0,
      ),
    },
  };
}

async function sourceTranscriptFiles(sourceRoot: string): Promise<string[]> {
  try {
    const sourceEntry = await fs.lstat(sourceRoot);
    if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) {
      throw new Error("transcript_archive_install_source_path_invalid");
    }
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return collectTranscriptFiles(sourceRoot);
}

export async function sanitizeTranscriptArchiveTreeForMigration(
  sourceRoot: string,
  targetRoot: string,
  options: TranscriptArchiveMigrationOptions = {},
): Promise<TranscriptArchiveMigrationManifest> {
  try {
    const targetEntry = await fs.lstat(targetRoot);
    if (!targetEntry.isDirectory() || targetEntry.isSymbolicLink()) {
      throw new Error("transcript_archive_install_target_path_invalid");
    }
    if ((await fs.readdir(targetRoot)).length > 0) {
      throw new Error("transcript_archive_install_target_not_empty");
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
  }

  const files: TranscriptArchiveMigrationFile[] = [];
  const quarantineRoot = path.resolve(
    options.quarantineRoot || `${targetRoot}.quarantine`,
  );
  for (const sourcePath of await sourceTranscriptFiles(sourceRoot)) {
    const relativePath = path.relative(sourceRoot, sourcePath);
    files.push(
      await sanitizeTranscriptArchiveFile(
        sourcePath,
        safeTargetPath(targetRoot, relativePath),
        relativePath,
        quarantineRoot,
      ),
    );
  }
  return buildManifest(files);
}

export async function synchronizeSanitizedTranscriptArchiveTreeForMigration(
  sourceRoot: string,
  targetRoot: string,
  previous: TranscriptArchiveMigrationManifest,
  options: TranscriptArchiveMigrationOptions = {},
): Promise<TranscriptArchiveMigrationManifest> {
  if (previous.version !== 1) {
    throw new Error("transcript_archive_install_manifest_invalid");
  }
  await fs.mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const priorFiles = new Map(
    previous.files.map((file) => [file.relativePath, file]),
  );
  const quarantineRoot = path.resolve(
    options.quarantineRoot || `${targetRoot}.quarantine`,
  );
  const nextFiles: TranscriptArchiveMigrationFile[] = [];
  const present = new Set<string>();
  for (const sourcePath of await sourceTranscriptFiles(sourceRoot)) {
    const relativePath = path.relative(sourceRoot, sourcePath);
    present.add(relativePath);
    const targetPath = safeTargetPath(targetRoot, relativePath);
    const sourceStat = await fs.stat(sourcePath);
    const prior = priorFiles.get(relativePath);
    let targetMatches = false;
    if (
      prior &&
      prior.sourceSize === sourceStat.size &&
      prior.sourceMtimeMs === Math.trunc(sourceStat.mtimeMs)
    ) {
      try {
        const targetStat = await fs.stat(targetPath);
        targetMatches =
          targetStat.isFile() && targetStat.size === prior.writtenSize;
      } catch {}
    }
    if (prior && targetMatches) {
      nextFiles.push(prior);
      continue;
    }
    const temporaryPath = `${targetPath}.migration-${process.pid}.tmp`;
    await fs.rm(temporaryPath, { force: true });
    try {
      const migrated = await sanitizeTranscriptArchiveFile(
        sourcePath,
        temporaryPath,
        relativePath,
        quarantineRoot,
      );
      await fs.rename(temporaryPath, targetPath);
      nextFiles.push(migrated);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
  }
  for (const relativePath of priorFiles.keys()) {
    if (!present.has(relativePath)) {
      await fs.rm(safeTargetPath(targetRoot, relativePath), { force: true });
    }
  }
  nextFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return buildManifest(nextFiles);
}
