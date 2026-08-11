import crypto from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Model } from "@earendil-works/pi-ai";
import {
  buildContextEntries,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

const HOME_DIR = os.homedir();

import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import { seedPiInMemorySessionManager } from "../pi/session-host.js";
import { openBoundSession } from "../session/factory.js";
import { readSessionMetadata } from "../session/metadata.js";
import { resolveAgentDir } from "./agent-dir.js";
import { safeString } from "./core/utils.js";
import { maintenanceLockPath } from "./paths.js";
import { buildSelfImproveReviewPrompt } from "./prompt.js";
import {
  beginSelfImproveAuditObservation,
  completeSelfImproveAuditObservation,
} from "./audit-observer.js";

export { buildSelfImproveReviewPrompt };

type ExtensionCtxLike = {
  model?: Model<any> | null;
};

type SessionEntryMetadata = {
  id: string;
  parentId: string | null;
  type: string;
  [key: string]: any;
};

async function visitSessionEntries(
  sessionFile: string,
  visit: (entry: Record<string, any>) => void,
) {
  const handle = await fs.open(sessionFile, "r");
  try {
    for await (const line of handle.readLines()) {
      if (!line.trim()) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry && typeof entry === "object") {
        visit(entry as Record<string, any>);
      }
    }
  } finally {
    await handle.close();
  }
}

function sessionEntryMetadata(entry: Record<string, any>) {
  const metadata: SessionEntryMetadata = {
    type: safeString(entry.type),
    id: safeString(entry.id).trim(),
    parentId:
      entry.parentId === null
        ? null
        : safeString(entry.parentId).trim() || null,
  };
  if (entry.type === "compaction") {
    metadata.firstKeptEntryId = safeString(entry.firstKeptEntryId).trim();
  } else if (entry.type === "model_change") {
    metadata.provider = safeString(entry.provider);
    metadata.modelId = safeString(entry.modelId);
  } else if (entry.type === "thinking_level_change") {
    metadata.thinkingLevel = safeString(entry.thinkingLevel);
  } else if (entry.type === "message" && entry.message?.role === "assistant") {
    metadata.assistantModel = {
      provider: safeString(entry.message.provider),
      modelId: safeString(entry.message.model),
    };
  }
  return metadata;
}

function pinnedSessionBranch(
  entriesById: Map<string, SessionEntryMetadata>,
  leafId: string,
) {
  const reversed: SessionEntryMetadata[] = [];
  const visited = new Set<string>();
  let current = entriesById.get(leafId);
  while (current) {
    if (visited.has(current.id)) {
      throw new Error(`self_improve_session_parent_cycle:${current.id}`);
    }
    visited.add(current.id);
    reversed.push(current);
    if (!current.parentId) break;
    const parent = entriesById.get(current.parentId);
    if (!parent) {
      throw new Error(
        `self_improve_session_parent_missing:${current.parentId}`,
      );
    }
    current = parent;
  }
  return reversed.reverse();
}

async function readPinnedContext(options: {
  sessionFile: string;
  leafId?: string;
}) {
  let header: SessionHeader | undefined;
  let lastEntryId = "";
  const entriesById = new Map<string, SessionEntryMetadata>();
  await visitSessionEntries(options.sessionFile, (entry) => {
    if (!header) {
      if (entry.type !== "session" || !safeString(entry.id).trim()) {
        throw new Error(
          `self_improve_session_invalid_header:${options.sessionFile}`,
        );
      }
      header = entry as SessionHeader;
      return;
    }
    const projected = sessionEntryMetadata(entry);
    if (!projected.id) return;
    entriesById.set(projected.id, projected);
    lastEntryId = projected.id;
  });
  if (!header) {
    throw new Error(
      `self_improve_session_invalid_header:${options.sessionFile}`,
    );
  }

  const leafId = safeString(options.leafId).trim() || lastEntryId;
  if (!leafId || !entriesById.has(leafId)) {
    throw new Error(`self_improve_session_leaf_missing:${leafId || "[empty]"}`);
  }
  const branch = pinnedSessionBranch(entriesById, leafId);
  const contextMetadata = buildContextEntries(
    branch as SessionEntry[],
    leafId,
    entriesById as Map<string, SessionEntry>,
  ) as SessionEntryMetadata[];
  const selectedIds = new Set(contextMetadata.map((entry) => entry.id));
  const selectedEntries = new Map<string, Record<string, any>>();
  await visitSessionEntries(options.sessionFile, (entry) => {
    const id = safeString(entry.id).trim();
    if (selectedIds.has(id)) selectedEntries.set(id, entry);
  });

  let model: { provider: string; modelId: string } | null = null;
  let thinkingLevel = "off";
  for (const entry of branch) {
    if (entry.type === "model_change") {
      model = { provider: entry.provider, modelId: entry.modelId };
    } else if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel;
    } else if (entry.assistantModel) {
      model = entry.assistantModel;
    }
  }

  const entries: Record<string, any>[] = contextMetadata.map((entry, index) => {
    const selected = selectedEntries.get(entry.id);
    if (!selected) {
      throw new Error(`self_improve_session_entry_missing:${entry.id}`);
    }
    return {
      ...selected,
      parentId: index === 0 ? null : contextMetadata[index - 1].id,
    };
  });
  let parentId = entries.at(-1)?.id || null;
  if (model) {
    const id = crypto.randomUUID();
    entries.push({
      type: "model_change",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      provider: model.provider,
      modelId: model.modelId,
    });
    parentId = id;
  }
  entries.push({
    type: "thinking_level_change",
    id: crypto.randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    thinkingLevel,
  });
  return { header, entries };
}

export async function createSelfImproveInMemorySession(options: {
  sessionFile: string;
  leafId?: string;
}) {
  const session = readSessionMetadata(options);
  const sessionFile = session.sessionFile
    ? path.resolve(session.sessionFile)
    : "";
  if (!sessionFile) throw new Error("session_file_required");
  const projection = await readPinnedContext({
    sessionFile,
    leafId: session.leafId || undefined,
  });
  const cwd = safeString(projection.header.cwd).trim() || HOME_DIR;
  const { SessionManager } = await loadRinSessionManagerModule();
  const sessionManager = SessionManager.inMemory(cwd, {
    id: projection.header.id,
    parentSession: sessionFile,
  });
  seedPiInMemorySessionManager(sessionManager, projection.entries);
  return { cwd, sessionManager };
}

async function runInMemorySessionPrompt(options: {
  agentDir: string;
  sessionFile: string;
  leafId?: string;
  prompt: string;
  additionalExtensionPaths?: string[];
}) {
  const contextSession = await createSelfImproveInMemorySession({
    sessionFile: options.sessionFile,
    leafId: options.leafId,
  });
  const { session, runtime } = await openBoundSession({
    cwd: contextSession.cwd,
    agentDir: options.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths,
    sessionManager: contextSession.sessionManager,
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

async function runInMemorySessionSelfImproveReview(options: {
  agentDir: string;
  runId: string;
  startedAt: string;
  sessionFile: string;
  leafId?: string;
  snapshotKey?: string;
  trigger?: string;
  additionalExtensionPaths?: string[];
}) {
  const startedAudit = await beginSelfImproveAuditObservation({
    agentDir: options.agentDir,
    runId: options.runId,
    kind: "self_improve_review",
    startedAt: options.startedAt,
    source: {
      sessionFile: options.sessionFile,
      leafId: options.leafId,
      snapshotKey: options.snapshotKey,
      trigger: options.trigger,
    },
  });
  let finalText: string;
  try {
    await assertUsableSessionFile(options.sessionFile);
    finalText = await runInMemorySessionPrompt({
      agentDir: options.agentDir,
      sessionFile: options.sessionFile,
      leafId: options.leafId,
      prompt: buildSelfImproveReviewPrompt(
        safeString(options.trigger).trim(),
        options.agentDir,
      ),
      additionalExtensionPaths: options.additionalExtensionPaths,
    });
  } catch (error) {
    const observed = await completeSelfImproveAuditObservation({
      agentDir: options.agentDir,
      handle: startedAudit.handle,
      status: "failed",
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      auditError: startedAudit.auditError,
    });
    const failure =
      error && typeof error === "object" ? error : new Error(String(error));
    Object.assign(failure, {
      selfImproveAudit: observed.audit,
      selfImproveAuditHandle: observed.auditHandle,
      selfImproveAuditError: observed.auditError,
    });
    throw failure;
  }

  const observed = await completeSelfImproveAuditObservation({
    agentDir: options.agentDir,
    handle: startedAudit.handle,
    status: "completed",
    finishedAt: new Date().toISOString(),
    output: finalText,
    auditError: startedAudit.auditError,
  });
  return {
    skipped: "",
    inMemory: true,
    saved: true,
    output: finalText,
    changedFiles: observed.changedFiles,
    audit: observed.audit,
    auditHandle: observed.auditHandle,
    auditError: observed.auditError,
  };
}

async function assertMaintenanceLockHeld(agentDir: string, handle: FileHandle) {
  const [pathStat, handleStat] = await Promise.all([
    fs.stat(maintenanceLockPath(agentDir)),
    handle.stat(),
  ]);
  if (pathStat.dev !== handleStat.dev || pathStat.ino !== handleStat.ino) {
    throw new Error("self_improve_maintenance_lock_required");
  }
}

/** Internal mutation boundary; callers must keep the supplied lock held through history acknowledgment. */
export async function runMaintainerUnderMaintenanceLock(
  _ctx: ExtensionCtxLike & { sessionManager?: any },
  opts: {
    agentDir?: string;
    sessionFile?: string;
    leafId?: string;
    trigger?: string;
    additionalExtensionPaths?: string[];
    runId?: string;
    startedAt?: string;
    snapshotKey?: string;
    maintenanceLockHandle: FileHandle;
  },
) {
  const session = readSessionMetadata(opts);
  const sessionFile = session.sessionFile;
  if (!sessionFile) return { skipped: "no-session-file" };
  const trigger = safeString(opts.trigger || "self_improve:review").trim();
  const leafId = session.leafId || undefined;
  const agentDir = resolveAgentDir(opts.agentDir);
  await assertMaintenanceLockHeld(agentDir, opts.maintenanceLockHandle);
  const extracted = await runInMemorySessionSelfImproveReview({
    agentDir,
    runId:
      safeString(opts.runId).trim() ||
      `self_improve_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
    startedAt: safeString(opts.startedAt).trim() || new Date().toISOString(),
    sessionFile,
    leafId,
    snapshotKey: safeString(opts.snapshotKey).trim() || undefined,
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
