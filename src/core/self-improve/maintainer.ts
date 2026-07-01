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
import { resolveAgentDir } from "./agent-dir.js";
import { safeString } from "./core/utils.js";
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

function selfImproveMaintenanceManualPath(agentDir: string) {
  return path.join(
    agentDir,
    "docs",
    "rin",
    "docs",
    "self-improve-distillation.md",
  );
}

export function buildSelfImproveReviewPrompt(
  trigger: string,
  agentDir = "<agentDir>",
): string {
  void trigger;
  const manualPath = selfImproveMaintenanceManualPath(agentDir);
  const libraryPath = path.join(agentDir, "self_improve");
  return `Use ${manualPath} as the self-improve distillation contract. Review ${libraryPath} with the conversation above as evidence for this scoped pass. Summarize reusable lessons learned and the user's working style as compact future-triggered guidance when the evidence shows a durable pattern. Maintain the clean target state of future guidance: apply the manual's evidence, trigger, target behavior, and owning surface checks; delete or rewrite wrong guidance before considering new guidance; reject patch-layer fixes. For correction-based or repeated-failure evidence, run a conflict retrieval pass over prompt baselines, reusable skills, memory-index indexes and transactions, and matching short-term records using the owner's exact trigger wording, behavior keywords, old abstraction names, and likely synonyms; read every plausible active hit and remove or rewrite active conflicting guidance before adding anything. Before reporting unchanged or success, replay the future trigger and confirm the cleaned library routes to one owner and no active hit still recommends the rejected behavior. Merge, move, prune, rewrite, delete, or add self-improve guidance only when it improves future behavior, routing, decisions, execution, recall, or removes guidance that would cause future mistakes. Cover prompt baselines, reusable skills, memory-index pointers, and short-term continuity records in one cohesive pass. Report changed artifacts, cleanup work, conflict-search closure, future-trigger replay, routed candidates, or one concise unchanged reason.`;
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
        // appending one distillation turn to the source conversation for
        // provider prefix-cache purposes. Keep the source session id as the
        // provider cache key while keeping distillation messages outside the
        // source transcript.
        preserveSourceSessionId: true,
        // Self-improve distillation forks are background turns. Routine
        // threshold-based compaction would add an extra model turn; keep
        // compaction for provider-error/context-overflow recovery.
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
    // Keep the source session's model options so provider prefix caching
    // matches a normal appended turn on the same conversation.
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
