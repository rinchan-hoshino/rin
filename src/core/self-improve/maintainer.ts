import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Model } from "@earendil-works/pi-ai";

const HOME_DIR = os.homedir();

import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import { openBoundSession } from "../session/factory.js";
import { forkSessionManagerCompat } from "../session/fork.js";
import { readSessionMetadata } from "../session/metadata.js";
import { safeString } from "./core/utils.js";
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

function selfImproveMemoryMaintenanceManualPath(agentDir: string) {
  return path.join(
    agentDir,
    "docs",
    "rin",
    "docs",
    "self-improve-memory-maintenance.md",
  );
}

export function buildSelfImproveReviewPrompt(
  trigger: string,
  agentDir = "<agentDir>",
): string {
  void trigger;
  const manualPath = selfImproveMemoryMaintenanceManualPath(agentDir);
  const libraryPath = path.join(agentDir, "self_improve");
  return `Follow the maintenance requirements in ${manualPath} to review the self-improve memory library under ${libraryPath} using the conversation above as evidence. Extract only durable reusable lessons, update existing memory only when it reduces future error or ambiguity, and prefer consolidation, pruning, or a no-op over adding new memory. Cover prompt baselines, reusable skills, memory-index skills, and short-term memory skills in one cohesive pass.`;
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
        // Memory-maintenance forks are background extraction turns. They should
        // not spend an extra model turn on ordinary threshold-based compaction;
        // only provider-error/context-overflow recovery should compact.
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
    // Do not override thinkingLevel here. The fork must inherit the source
    // session's model options so provider prefix caching matches a normal
    // appended turn on the same conversation.
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
    prompt: buildSelfImproveReviewPrompt(
      safeString(options.trigger).trim(),
      options.agentDir,
    ),
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
