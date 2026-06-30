import fs from "node:fs";
import path from "node:path";

import { extractPiContinuableToolCallParts } from "../pi/tool-continuation.js";
import { coreDataPath } from "../data-layout.js";
import { normalizeSessionRef } from "../session/ref.js";

const ACTIVE_TURNS_FILE = "active-turns.json";
const DEFAULT_INTERRUPTED_SCAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_INTERRUPTED_SCAN_MAX_FILES = 500;

type ActiveTurnState = {
  schemaVersion: 1;
  sessionFiles: string[];
};

export function activeTurnSessionsStatePath(agentDir: string) {
  return coreDataPath(agentDir, "workers", ACTIVE_TURNS_FILE);
}

function normalizeSessionFile(value: unknown) {
  return normalizeSessionRef({ sessionFile: value }).sessionFile;
}

function readState(filePath: string): ActiveTurnState {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const rawSessionFiles = Array.isArray(parsed?.sessionFiles)
      ? parsed.sessionFiles
      : [];
    const seen = new Set<string>();
    const sessionFiles: string[] = [];
    for (const value of rawSessionFiles) {
      const sessionFile = normalizeSessionFile(value);
      if (!sessionFile || seen.has(sessionFile)) continue;
      seen.add(sessionFile);
      sessionFiles.push(sessionFile);
    }
    return { schemaVersion: 1, sessionFiles };
  } catch {
    return { schemaVersion: 1, sessionFiles: [] };
  }
}

function writeState(filePath: string, state: ActiveTurnState) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tmpPath, filePath);
}

export function listActiveTurnSessionFiles(agentDir: string) {
  return readState(activeTurnSessionsStatePath(agentDir)).sessionFiles;
}

export function setActiveTurnSession(
  agentDir: string | undefined,
  sessionFile: string | undefined,
  active: boolean,
) {
  if (!agentDir || !sessionFile) return;
  const filePath = activeTurnSessionsStatePath(agentDir);
  const normalized = normalizeSessionFile(sessionFile);
  if (!normalized) return;
  const state = readState(filePath);
  const sessionFiles = state.sessionFiles.filter(
    (entry) => entry !== normalized,
  );
  if (active) sessionFiles.push(normalized);
  writeState(filePath, { schemaVersion: 1, sessionFiles });
}

function isJsonlSessionFile(filePath: string) {
  return filePath.endsWith(".jsonl");
}

function collectRecentSessionFiles(
  root: string,
  options: { now: number; maxAgeMs: number; maxFiles: number },
) {
  const pending = [root];
  const files: { path: string; mtimeMs: number }[] = [];
  while (pending.length) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const itemPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(itemPath);
        continue;
      }
      if (!entry.isFile() || !isJsonlSessionFile(itemPath)) continue;
      try {
        const stat = fs.statSync(itemPath);
        if (options.now - stat.mtimeMs > options.maxAgeMs) continue;
        files.push({ path: itemPath, mtimeMs: stat.mtimeMs });
      } catch {}
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, options.maxFiles).map((item) => item.path);
}

function lastPersistedMessageFromSessionFile(sessionFile: string) {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile, "utf8");
  } catch {
    return undefined;
  }
  const lines = raw.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "message") return entry.message;
    } catch {}
  }
  return undefined;
}

export function hasInterruptedToolCallTail(sessionFile: string) {
  const message = lastPersistedMessageFromSessionFile(sessionFile);
  return extractPiContinuableToolCallParts(message).length > 0;
}

export function listRecentInterruptedTurnSessionFiles(
  agentDir: string,
  options: {
    now?: number;
    maxAgeMs?: number;
    maxFiles?: number;
  } = {},
) {
  const sessionRoot = path.join(agentDir, "sessions");
  const files = collectRecentSessionFiles(sessionRoot, {
    now: Number(options.now ?? Date.now()),
    maxAgeMs: Math.max(
      0,
      Number(options.maxAgeMs ?? DEFAULT_INTERRUPTED_SCAN_MAX_AGE_MS),
    ),
    maxFiles: Math.max(
      1,
      Number(options.maxFiles ?? DEFAULT_INTERRUPTED_SCAN_MAX_FILES),
    ),
  });
  const interrupted: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const sessionFile = normalizeSessionFile(file);
    if (!sessionFile || seen.has(sessionFile)) continue;
    if (!hasInterruptedToolCallTail(sessionFile)) continue;
    seen.add(sessionFile);
    interrupted.push(sessionFile);
  }
  return interrupted;
}
