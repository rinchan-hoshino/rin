import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Model } from "@mariozechner/pi-ai";

const HOME_DIR = os.homedir();

import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import { openBoundSession } from "../session/factory.js";
import { forkSessionManagerCompat } from "../session/fork.js";
import { readSessionMetadata } from "../session/metadata.js";
import { normalizeSessionValue } from "../session/ref.js";
import {
  buildSessionRecallSummaryPrompt,
  normalizeSessionSummaryText,
} from "../session/summary.js";
import {
  appendTranscriptArchiveEntry,
  getTranscriptArchivePath,
  loadTranscriptSessionEntries,
} from "../memory/transcripts.js";
import { nowIso, safeString } from "./core/utils.js";
import { resolveAgentDir } from "./lib.js";
import { selfImprovePromptsDir, selfImproveSkillsDir } from "./paths.js";

type ExtensionCtxLike = {
  model?: Model<any> | null;
};

type MaintenanceChangedFile = {
  path: string;
  change: "created" | "updated" | "deleted";
};

async function collectManagedFiles(dir: string): Promise<string[]> {
  if (!fssync.existsSync(dir)) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectManagedFiles(fullPath)));
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

async function captureManagedArtifactSnapshot(agentDir: string) {
  const root = path.resolve(agentDir);
  const paths = [
    ...(await collectManagedFiles(selfImprovePromptsDir(root))),
    ...(await collectManagedFiles(selfImproveSkillsDir(root))),
  ].sort();
  const snapshot = new Map<string, string>();
  for (const filePath of paths) {
    const relativePath = path.relative(root, filePath) || filePath;
    const buffer = await fs.readFile(filePath);
    snapshot.set(
      filePath,
      `${relativePath}:${createHash("sha1").update(buffer).digest("hex")}`,
    );
  }
  return snapshot;
}

function diffManagedArtifactSnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
): MaintenanceChangedFile[] {
  const changed: MaintenanceChangedFile[] = [];
  const allPaths = new Set([...before.keys(), ...after.keys()]);
  for (const filePath of [...allPaths].sort()) {
    const beforeHash = before.get(filePath);
    const afterHash = after.get(filePath);
    if (!beforeHash && afterHash) {
      changed.push({ path: filePath, change: "created" });
      continue;
    }
    if (beforeHash && !afterHash) {
      changed.push({ path: filePath, change: "deleted" });
      continue;
    }
    if (beforeHash !== afterHash) {
      changed.push({ path: filePath, change: "updated" });
    }
  }
  return changed;
}

function buildSelfImproveReviewPrompt(_trigger: string): string {
  const prompt = [
    "Review the conversation and derive durable conclusions that should still matter across sessions.",
    "Use save_prompts for prompt baselines and skills for reusable procedures, materials, and knowledge.",
    "Simultaneously consolidate, compress, and improve existing prompt slots and skills instead of only adding new content.",
  ];

  return prompt.join(" ");
}

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
        // appending one maintenance turn to the source conversation for
        // provider prefix-cache purposes. Keep the source session id as the
        // provider cache key while still preventing maintenance messages from
        // being written back to the source transcript.
        preserveSourceSessionId: true,
      },
    ),
  };
}

export function disableRoutineCompactionForMaintenanceFork(session: any) {
  if (!session || typeof session !== "object") return;
  // Memory-maintenance forks are background extraction turns. They should not
  // spend an extra model turn on ordinary threshold-based compaction; only the
  // runtime's provider-error/context-overflow recovery path should compact when
  // the request would otherwise fail.
  session.autoCompactionEnabled = false;
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
    sessionManager: fork.sessionManager,
    // Do not override thinkingLevel here. The fork must inherit the source
    // session's model options so provider prefix caching matches a normal
    // appended turn on the same conversation.
  });
  disableRoutineCompactionForMaintenanceFork(session);
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

function isSessionSummaryEntry(entry: { role?: string; customType?: string }) {
  return (
    safeString(entry.role || "").trim() === "sessionSummary" ||
    safeString(entry.customType || "").trim() === "session_summary"
  );
}

async function storeSessionSummaryInTranscriptArchive(options: {
  agentDir: string;
  sessionFile: string;
  summary: string;
}) {
  const normalizedAgentDir = normalizeSessionValue(options.agentDir);
  const normalizedSessionFile = normalizeSessionValue(options.sessionFile);
  const agentDir = normalizedAgentDir ? path.resolve(normalizedAgentDir) : "";
  const sessionFile = normalizedSessionFile
    ? path.resolve(normalizedSessionFile)
    : "";
  const summary = normalizeSessionSummaryText(options.summary);
  if (!sessionFile || !summary) {
    return { skipped: "empty-summary" };
  }

  const { SessionManager } = await loadRinSessionManagerModule();
  const sessionManager = SessionManager.open(
    sessionFile,
    path.dirname(sessionFile),
  );
  const sessionInfo = readSessionMetadata(sessionManager);
  const sessionId = sessionInfo.sessionId;
  const existingEntries = await loadTranscriptSessionEntries(
    {
      sessionId: sessionId || undefined,
      sessionFile,
    },
    agentDir,
  ).catch(() => []);
  const currentSummary = normalizeSessionSummaryText(
    [...existingEntries].reverse().find((entry) => isSessionSummaryEntry(entry))
      ?.text || "",
  );
  const timestamp = nowIso();
  const archivePath = getTranscriptArchivePath(
    {
      timestamp,
      sessionId,
      sessionFile,
    },
    agentDir,
  );
  if (currentSummary && currentSummary === summary) {
    return {
      skipped: "unchanged",
      sessionId: sessionId || undefined,
      sessionSummary: currentSummary,
      changedFiles: [] as MaintenanceChangedFile[],
    };
  }

  await appendTranscriptArchiveEntry(
    {
      timestamp,
      sessionId,
      sessionFile,
      role: "sessionSummary",
      customType: "session_summary",
      text: summary,
      display: false,
    },
    agentDir,
  );
  return {
    skipped: "",
    sessionId: sessionId || undefined,
    sessionSummary: summary,
    changedFiles: [
      {
        path: archivePath,
        change: currentSummary ? "updated" : "created",
      },
    ] as MaintenanceChangedFile[],
  };
}

async function runForkedSessionSelfImproveReview(options: {
  agentDir: string;
  sessionFile: string;
  leafId?: string;
  trigger?: string;
  additionalExtensionPaths?: string[];
}) {
  const before = await captureManagedArtifactSnapshot(options.agentDir);
  const finalText = await runForkedSessionPrompt({
    agentDir: options.agentDir,
    sessionFile: options.sessionFile,
    leafId: options.leafId,
    prompt: buildSelfImproveReviewPrompt(safeString(options.trigger).trim()),
    additionalExtensionPaths: options.additionalExtensionPaths,
  });
  const after = await captureManagedArtifactSnapshot(options.agentDir);
  return {
    skipped: "",
    forked: true,
    saved: true,
    output: finalText,
    changedFiles: diffManagedArtifactSnapshots(before, after),
  };
}

export async function maintainMemory(
  _ctx: ExtensionCtxLike & { sessionManager?: any },
  opts: {
    agentDir?: string;
    sessionFile?: string;
    leafId?: string;
    trigger?: string;
    additionalExtensionPaths?: string[];
  } = {},
) {
  const session = readSessionMetadata(opts);
  const sessionFile = session.sessionFile;
  if (!sessionFile) return { skipped: "no-session-file" };
  const trigger = safeString(opts.trigger || "self_improve:review").trim();
  const leafId = session.leafId || undefined;
  const extracted = await runForkedSessionSelfImproveReview({
    agentDir: resolveAgentDir(opts.agentDir),
    sessionFile,
    leafId,
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

export async function maintainSessionSummary(
  _ctx: ExtensionCtxLike & { sessionManager?: any },
  opts: {
    agentDir?: string;
    sessionFile?: string;
    leafId?: string;
    trigger?: string;
  } = {},
) {
  const session = readSessionMetadata(opts);
  const sessionFile = session.sessionFile;
  if (!sessionFile) return { skipped: "no-session-file" };
  const agentDir = resolveAgentDir(opts.agentDir);
  const leafId = session.leafId || undefined;
  const trigger = safeString(opts.trigger || "session_summary:review").trim();
  const output = await runForkedSessionPrompt({
    agentDir,
    sessionFile,
    leafId,
    prompt: buildSessionRecallSummaryPrompt(sessionFile),
  });
  const applied = await storeSessionSummaryInTranscriptArchive({
    agentDir,
    sessionFile,
    summary: output,
  });
  return {
    ...applied,
    mode: "session",
    sessionFile,
    leafId,
    trigger,
    output,
  };
}
