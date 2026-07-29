import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME_DIR = os.homedir();

import type { ChatOutboxPayload } from "../rin-lib/chat-outbox.js";
import {
  MANAGED_TASK_SESSION_LEAF,
  getManagedTaskSessionFile,
} from "../session/managed-paths.js";
import { resolveTurnCompletion } from "../session/turn-result.js";
import { cronTaskRunId, nowIso, summarizeText } from "./cron-utils.js";
import { normalizeScheduledTaskSessionMode } from "../scheduled-task-options.js";
import {
  acquireSelfImproveMaintenanceLock,
  releaseSelfImproveMaintenanceLock,
} from "../self-improve/async-jobs.js";
import { maintenanceHistoryPath } from "../self-improve/paths.js";
import {
  acknowledgeSelfImproveRunAudit,
  beginSelfImproveRunAudit,
  completeSelfImproveRunAudit,
  markSelfImproveRunAuditExecutionStarted,
  resolveSafeSelfImprovePath,
  sanitizeSelfImproveHistoryText,
  type SelfImproveRunAuditHandle,
  type SelfImproveRunAuditReference,
} from "../self-improve/run-audit.js";
import type {
  CronSessionInvocation,
  CronTaskFrontendBinding,
  CronTaskRecord,
} from "./cron.js";

type CronChatCapability = {
  send?: (payload: ChatOutboxPayload) => Promise<any>;
  runTurn?: (payload: any) => Promise<any>;
  setWorkingVisible?: (payload: {
    chatKey?: string;
    controllerKey?: string;
    visible?: boolean;
  }) => Promise<any>;
  terminateTurn?: (payload: {
    controllerKey?: string;
    chatKey?: string;
  }) => Promise<any>;
};

export async function sendChatText(
  options: { chat?: CronChatCapability },
  payload: {
    chatKey: string;
    taskId: string;
    runId: string;
    text: string;
    sessionFile?: string;
  },
) {
  if (typeof options.chat?.send !== "function") {
    throw new Error("cron_chat_unavailable");
  }
  await options.chat.send({
    createdAt: nowIso(),
    chatKey: payload.chatKey,
    taskId: payload.taskId,
    runId: payload.runId,
    parts: [{ type: "text", text: payload.text }],
    ...(payload.sessionFile
      ? {
          sessionFile: payload.sessionFile,
          sessionBinding: "conversation" as const,
        }
      : {}),
  });
}

export async function resolveCronSessionFile(task: CronTaskRecord) {
  const mode = normalizeScheduledTaskSessionMode((task.session as any)?.mode);
  if (mode === "dedicated") {
    const sessionFile = String(task.dedicatedSessionFile || "").trim();
    return sessionFile && existsSync(sessionFile) ? sessionFile : undefined;
  }
  if (mode === "none") return undefined;
  throw new Error(
    `cron_invalid_session_mode:${String((task.session as any)?.mode || "unknown")}`,
  );
}

function findBashOnPath(): string | null {
  try {
    const result = spawnSync("which", ["bash"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch) return firstMatch;
    }
  } catch {}
  return null;
}

async function getCronShellConfig(agentDir: string) {
  try {
    const raw = await readFile(path.join(agentDir, "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    const customShellPath = String(settings?.shellPath || "").trim();
    if (customShellPath) {
      if (existsSync(customShellPath)) {
        return { shell: customShellPath, args: ["-c"] };
      }
      throw new Error(`Custom shell path not found: ${customShellPath}`);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (existsSync("/bin/bash")) {
    return { shell: "/bin/bash", args: ["-c"] };
  }

  const bashOnPath = findBashOnPath();
  if (bashOnPath) {
    return { shell: bashOnPath, args: ["-c"] };
  }

  return { shell: "sh", args: ["-c"] };
}

export async function executeCronShellTask(
  task: CronTaskRecord,
  options: { agentDir: string },
) {
  if (task.target.kind !== "shell_command")
    throw new Error("cron_invalid_shell_task");
  const { command } = task.target;
  const { shell, args } = await getCronShellConfig(options.agentDir);
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(shell, [...args, command], {
      cwd: HOME_DIR,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const body = [
        `Command: ${command}`,
        `Exit: ${signal ? `signal ${signal}` : (code ?? 0)}`,
        stdout.trim() ? `stdout:\n${summarizeText(stdout, 4000)}` : "",
        stderr.trim() ? `stderr:\n${summarizeText(stderr, 4000)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      if (code === 0 && !signal) resolve(body);
      else reject(new Error(body || "cron_command_failed"));
    });
  });
}

function resolveCronTaskFrontend(task: Pick<CronTaskRecord, "frontend">) {
  const frontend = (task as any).frontend as
    | CronTaskFrontendBinding
    | undefined;
  const kind = String(frontend?.kind || "").trim() || undefined;
  if (kind === "tui") return undefined;
  const key = String(frontend?.key || "").trim();
  if (!key) return undefined;
  return {
    key,
    ...(kind ? { kind } : {}),
  };
}

function cronTaskRunControllerKey(task: CronTaskRecord) {
  const frontend = resolveCronTaskFrontend(task);
  return frontend && frontend.kind !== "chat" ? frontend.key : task.id;
}

function shouldDeliverCronTaskFinal(
  task: CronTaskRecord,
  frontend: ReturnType<typeof resolveCronTaskFrontend>,
) {
  return task.deliverFinal !== false && frontend?.kind === "chat";
}

async function setCronTaskFrontendWorking(
  task: CronTaskRecord,
  options: { chat?: CronChatCapability },
  visible: boolean,
) {
  if (typeof options.chat?.setWorkingVisible !== "function") return false;
  const frontend = resolveCronTaskFrontend(task);
  if (!frontend) return false;
  const chatKey = frontend.kind === "chat" ? frontend.key : undefined;
  await options.chat
    .setWorkingVisible({
      ...(chatKey
        ? { chatKey }
        : { controllerKey: cronTaskRunControllerKey(task) }),
      visible,
    })
    .catch(() => {});
  return true;
}

export function buildCronTaskPromptContext(
  task: Pick<CronTaskRecord, "id" | "name" | "frontend">,
  sentAt = Date.now(),
) {
  const taskName = String(task.name || "").trim();
  const frontend = resolveCronTaskFrontend(task);
  return {
    source: "scheduled-task",
    sentAt,
    ...(frontend?.kind === "chat" ? { chatKey: frontend.key } : {}),
    frontend,
    taskId: task.id,
    taskName: taskName || undefined,
    taskContextKind: "scheduled-task",
    selfImproveEligible: true,
  };
}

function isSelfImproveDistillationTask(task: CronTaskRecord) {
  if (task.id === "builtin_self_improve_sleep_consolidation_daily") return true;
  if (task.target.kind !== "agent_prompt") return false;
  const prompt = [task.target.prompt, task.target.continuationPrompt]
    .map((value) => String(value || ""))
    .join("\n");
  return prompt.includes("self-improve-distillation.md");
}

function shouldShutdownTaskSessionAfterRun(sessionMode: string) {
  return sessionMode === "none";
}

function recoverCronHistoryText(existing: string) {
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

async function writePrivateCronHistoryAtomic(
  filePath: string,
  content: string,
) {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, filePath);
    const directoryHandle = await open(path.dirname(filePath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function appendCronMaintenanceHistoryRecord(
  agentDir: string,
  task: CronTaskRecord,
  record: {
    status: "completed" | "failed";
    startedAt?: string;
    finishedAt: string;
    outputPreview?: string;
    error?: string;
    sessionFile?: string;
    audit?: SelfImproveRunAuditReference;
    historyRedacted?: boolean;
    historyTruncated?: boolean;
  },
) {
  if (!isSelfImproveDistillationTask(task)) return;
  let filePath = await resolveSafeSelfImprovePath(
    agentDir,
    maintenanceHistoryPath(agentDir),
  );
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  filePath = await resolveSafeSelfImprovePath(agentDir, filePath);
  const baseRecordId = `${task.id}:${task.runCount}`;
  let historyRedacted = record.audit?.redacted === true;
  let historyTruncated = record.audit?.truncated === true;
  const historyText = (value: string | undefined, maxBytes: number) => {
    if (!value) return undefined;
    const sanitized = sanitizeSelfImproveHistoryText(value, maxBytes);
    historyRedacted ||= sanitized.redacted;
    historyTruncated ||= sanitized.truncated;
    return sanitized.text || undefined;
  };
  const outputEvidence = historyText(record.outputPreview, 256 * 1024);
  const outputPreview = outputEvidence
    ? summarizeText(outputEvidence, 800)
    : undefined;
  const error = historyText(record.error, 64 * 1024);
  const sessionFile = historyText(record.sessionFile, 4 * 1024);
  const trigger = historyText(`cron:${task.id}`, 4 * 1024);
  const audit = record.audit
    ? {
        version: 1 as const,
        auditId: record.audit.auditId,
        path: record.audit.path,
        sha256: record.audit.sha256,
        complete: record.audit.complete,
        redacted: record.audit.redacted,
        truncated: record.audit.truncated,
      }
    : undefined;
  const rawExisting = await readFile(filePath, "utf8").catch((error: any) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const existing = recoverCronHistoryText(rawExisting);
  if (existing !== rawExisting) {
    await writePrivateCronHistoryAtomic(filePath, existing);
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
  const identity =
    audit?.sha256 ||
    audit?.auditId ||
    createHash("sha256")
      .update(
        JSON.stringify({
          id: baseRecordId,
          startedAt: record.startedAt,
          sessionFile,
        }),
      )
      .digest("hex");
  const sameRun = (entry: any) =>
    entry?.id === baseRecordId || entry?.runId === baseRecordId;
  if (
    audit?.auditId &&
    existingRecords.some(
      (entry) =>
        entry?.audit?.auditId === audit.auditId &&
        (!sameRun(entry) ||
          entry?.kind !== "self_improve_review" ||
          entry?.status !== record.status ||
          entry?.audit?.version !== audit.version ||
          entry?.audit?.path !== audit.path ||
          entry?.audit?.sha256 !== audit.sha256 ||
          entry?.audit?.complete !== audit.complete ||
          entry?.audit?.redacted !== audit.redacted ||
          entry?.audit?.truncated !== audit.truncated),
    )
  ) {
    throw new Error("self_improve_audit_history_corrupt");
  }
  if (
    existingRecords.some(
      (entry) =>
        sameRun(entry) &&
        (audit
          ? audit.auditId
            ? entry?.audit?.auditId === audit.auditId
            : entry?.audit?.sha256 === audit.sha256 &&
              entry?.audit?.path === audit.path &&
              entry?.status === record.status
          : !entry?.audit && entry?.startedAt === record.startedAt),
    )
  ) {
    await chmod(filePath, 0o600);
    const historyHandle = await open(filePath, "r+");
    try {
      await historyHandle.sync();
    } finally {
      await historyHandle.close();
    }
    const directoryHandle = await open(path.dirname(filePath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return;
  }
  const recordId = existingRecords.some(sameRun)
    ? `${baseRecordId}@${identity.slice(0, 12)}`
    : baseRecordId;
  await writePrivateCronHistoryAtomic(
    filePath,
    `${existing}${JSON.stringify({
      id: recordId,
      runId: baseRecordId,
      kind: "self_improve_review",
      status: record.status,
      trigger,
      sessionFile,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      attempts: 1,
      outputPreview,
      error,
      audit,
      historyRedacted: historyRedacted || undefined,
      historyTruncated: historyTruncated || undefined,
    })}\n`,
  );
}

export async function executeCronAgentTask(
  task: CronTaskRecord,
  options: {
    agentDir: string;
    additionalExtensionPaths?: string[];
    chat?: CronChatCapability;
    runId?: string;
    sessionFile?: string;
    promptMeta?: Record<string, unknown> & { sentAt: number };
    deliveryIdempotencyKey?: string;
    continuing?: boolean;
  },
) {
  if (task.target.kind !== "agent_prompt")
    throw new Error("cron_invalid_agent_task");
  if (typeof options.chat?.runTurn !== "function") {
    throw new Error("cron_chat_unavailable");
  }
  const sessionMode =
    normalizeScheduledTaskSessionMode((task.session as any)?.mode) || "none";
  const dedicatedSessionFile =
    sessionMode === "dedicated"
      ? String(task.dedicatedSessionFile || "").trim() ||
        getManagedTaskSessionFile(options.agentDir, task.id)
      : undefined;
  const frontend = resolveCronTaskFrontend(task);
  const chatKey = frontend?.kind === "chat" ? frontend.key : undefined;
  const controllerKey = cronTaskRunControllerKey(task);
  const sessionFile =
    String(options.sessionFile || "").trim() ||
    (await resolveCronSessionFile(task));
  const continuing =
    typeof options.continuing === "boolean"
      ? options.continuing
      : Boolean(
          sessionMode === "dedicated" &&
          ((sessionFile && existsSync(sessionFile)) || task.runCount > 1),
        );
  const basePrompt = continuing
    ? String(task.target.continuationPrompt || "").trim()
    : String(task.target.prompt || "").trim();
  if (!basePrompt) throw new Error("cron_prompt_required");
  const prompt = basePrompt;
  const result = await options.chat.runTurn({
    controllerKey,
    ...(chatKey
      ? {
          chatKey,
          affectChatBinding: false,
          linkDeliveriesToSession: true,
          deliverFinal: task.deliverFinal !== false,
          quietMode: task.quiet !== false,
        }
      : { affectChatBinding: false, quietMode: task.quiet !== false }),
    disposeAfterTurn: sessionMode === "none",
    shutdownAfterTurn: shouldShutdownTaskSessionAfterRun(sessionMode),
    text: prompt,
    sessionFile: sessionFile || dedicatedSessionFile,
    ...(options.runId ? { requestTag: options.runId } : {}),
    ...(options.deliveryIdempotencyKey
      ? { deliveryIdempotencyKey: options.deliveryIdempotencyKey }
      : {}),
    ...((sessionFile || dedicatedSessionFile) &&
    !existsSync(String(sessionFile || dedicatedSessionFile))
      ? { createSessionFileIfMissing: true }
      : {}),
    ...(sessionMode === "none"
      ? { managedSessionLeaf: MANAGED_TASK_SESSION_LEAF }
      : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(task.thinkingLevel ? { thinkingLevel: task.thinkingLevel } : {}),
    ...(task.disabledRinCapabilities
      ? { disabledRinCapabilities: task.disabledRinCapabilities }
      : {}),
    frontend: frontend
      ? {
          kind: frontend.kind || "scheduled-task",
          key: frontend.key,
        }
      : { kind: "scheduled-task", key: task.id },
    promptMeta: options.promptMeta || buildCronTaskPromptContext(task),
  });
  const completion = resolveTurnCompletion(result);
  const terminalEvidence = isSelfImproveDistillationTask(task)
    ? sanitizeSelfImproveHistoryText(completion.finalText, 256 * 1024).text
    : completion.finalText;
  const finalText = summarizeText(terminalEvidence, 4000);
  const nextSessionFile = String(result?.sessionFile || "").trim() || undefined;
  const keepChatBoundSession = Boolean(chatKey && nextSessionFile);
  if (sessionMode === "dedicated") {
    if (dedicatedSessionFile) {
      task.dedicatedSessionFile = dedicatedSessionFile;
      task.dedicatedSessionPersistent = true;
    } else {
      delete task.dedicatedSessionFile;
      task.dedicatedSessionPersistent = true;
    }
  }
  return {
    text: finalText,
    auditOutput: completion.finalText,
    sessionId: String(result?.sessionId || "").trim() || undefined,
    sessionFile:
      sessionMode === "none"
        ? keepChatBoundSession
          ? nextSessionFile
          : undefined
        : dedicatedSessionFile,
  };
}

export type CronTaskTerminal = {
  status: "completed" | "failed";
  text?: string;
  error?: string;
  sessionFile?: string;
  audit?: SelfImproveRunAuditReference;
  historyCommitted?: boolean;
};

export function createCronSessionInvocation(
  task: CronTaskRecord,
  agentDir: string,
): CronSessionInvocation {
  if (task.target.kind !== "agent_prompt") {
    throw new Error("cron_invalid_agent_task");
  }
  const startedAt = task.lastStartedAt || nowIso();
  const id = cronTaskRunId(task, startedAt);
  const sessionMode = normalizeScheduledTaskSessionMode(task.session.mode);
  const sessionFile =
    sessionMode === "dedicated"
      ? String(task.dedicatedSessionFile || "").trim() ||
        getManagedTaskSessionFile(agentDir, task.id)
      : getManagedTaskSessionFile(agentDir, id);
  return {
    id,
    requestTag: `scheduled:${id}`,
    taskId: task.id,
    runCount: task.runCount,
    startedAt,
    scheduledNextRunAt: task.nextRunAt,
    sessionFile,
    continuing:
      sessionMode === "dedicated" &&
      (existsSync(sessionFile) || task.runCount > 1),
    name: task.name,
    frontend: task.frontend ? { ...task.frontend } : undefined,
    deliverFinal: task.deliverFinal,
    quiet: task.quiet,
    model: task.model,
    thinkingLevel: task.thinkingLevel,
    disabledRinCapabilities: task.disabledRinCapabilities
      ? [...task.disabledRinCapabilities]
      : undefined,
    session: { ...task.session },
    target: { ...task.target },
    promptMeta: buildCronTaskPromptContext(
      task,
      Date.parse(startedAt) || Date.now(),
    ),
  };
}

function taskFromSessionInvocation(
  invocation: CronSessionInvocation,
): CronTaskRecord {
  return {
    id: invocation.taskId,
    createdAt: invocation.startedAt,
    updatedAt: invocation.startedAt,
    name: invocation.name,
    enabled: true,
    frontend: invocation.frontend,
    deliverFinal: invocation.deliverFinal,
    quiet: invocation.quiet,
    model: invocation.model,
    thinkingLevel: invocation.thinkingLevel,
    disabledRinCapabilities: invocation.disabledRinCapabilities,
    trigger: {},
    session: invocation.session,
    target: invocation.target,
    dedicatedSessionFile:
      invocation.session.mode === "dedicated"
        ? invocation.sessionFile
        : undefined,
    dedicatedSessionPersistent:
      invocation.session.mode === "dedicated" ? true : undefined,
    nextRunAt: invocation.scheduledNextRunAt,
    lastStartedAt: invocation.startedAt,
    runCount: invocation.runCount,
    running: true,
  };
}

export async function executeCronSessionInvocation(
  invocation: CronSessionInvocation,
  options: {
    agentDir: string;
    additionalExtensionPaths?: string[];
    chat?: CronChatCapability;
  },
) {
  const task = taskFromSessionInvocation(invocation);
  const audited = isSelfImproveDistillationTask(task);
  const maintenanceLock = audited
    ? await acquireSelfImproveMaintenanceLock(options.agentDir)
    : null;
  if (audited && !maintenanceLock) {
    throw new Error("self_improve_maintenance_lock_timeout");
  }
  try {
    const auditHandle = audited
      ? await beginSelfImproveRunAudit({
          agentDir: options.agentDir,
          runId: `${task.id}:${task.runCount}`,
          kind: "cron",
          startedAt: invocation.startedAt,
          source: { trigger: `cron:${task.id}` },
        })
      : undefined;
    try {
      if (auditHandle?.completedPath) {
        const audit = await completeSelfImproveRunAudit({
          agentDir: options.agentDir,
          handle: auditHandle,
          status: "completed",
          finishedAt: nowIso(),
        });
        const exactEvidence =
          audit.evidenceRetained !== false && audit.complete;
        if (audit.status === "failed") {
          const error = new Error(
            exactEvidence
              ? audit.error || "self_improve_audit_recovered_failure"
              : "self_improve_audit_recovered_incomplete_failure",
          );
          Object.assign(error, {
            rinTurnTerminal: true,
            selfImproveAudit: audit,
          });
          throw error;
        }
        const recoveredOutput = exactEvidence
          ? audit.output || ""
          : "Self-improve run already completed; exact terminal output evidence was redacted or truncated.";
        const restored = {
          text: summarizeText(recoveredOutput, 4_000),
          auditOutput: recoveredOutput,
          sessionFile: undefined,
          audit,
          auditHistoryCommitted: true,
        };
        await appendCronTaskTerminalHistory(
          task,
          { status: "completed", text: restored.text, audit },
          { agentDir: options.agentDir, startedAt: invocation.startedAt },
        );
        await acknowledgeSelfImproveRunAudit({
          agentDir: options.agentDir,
          handle: auditHandle,
          reference: audit,
        });
        return restored;
      }
      if (auditHandle?.executionInterrupted) {
        const error = new Error("self_improve_audit_interrupted_execution");
        Object.assign(error, { rinTurnTerminal: true });
        throw error;
      }
      if (auditHandle) {
        await markSelfImproveRunAuditExecutionStarted({
          agentDir: options.agentDir,
          handle: auditHandle,
        });
      }
      const result = await executeCronAgentTask(task, {
        ...options,
        runId: invocation.requestTag,
        sessionFile: invocation.sessionFile,
        promptMeta: invocation.promptMeta,
        deliveryIdempotencyKey: `scheduled-final:${invocation.id}`,
        continuing: invocation.continuing,
      });
      const audit = auditHandle
        ? await completeSelfImproveRunAudit({
            agentDir: options.agentDir,
            handle: auditHandle,
            status: "completed",
            finishedAt: nowIso(),
            output: result.auditOutput,
          })
        : undefined;
      if (audit) {
        await appendCronTaskTerminalHistory(
          task,
          {
            status: "completed",
            text: result.text,
            sessionFile: result.sessionFile,
            audit,
          },
          { agentDir: options.agentDir, startedAt: invocation.startedAt },
        );
        await acknowledgeSelfImproveRunAudit({
          agentDir: options.agentDir,
          handle: auditHandle!,
          reference: audit,
        });
      }
      return { ...result, audit, auditHistoryCommitted: Boolean(audit) };
    } catch (error) {
      if (auditHandle && (error as any)?.rinTurnTerminal === true) {
        const audit = await completeSelfImproveRunAudit({
          agentDir: options.agentDir,
          handle: auditHandle,
          status: "failed",
          finishedAt: nowIso(),
          error: error instanceof Error ? error.message : String(error),
        });
        if (error && typeof error === "object") {
          Object.assign(error, { selfImproveAudit: audit });
        }
      }
      const terminalAudit = (error as any)?.selfImproveAudit;
      if (terminalAudit) {
        await appendCronTaskTerminalHistory(
          task,
          {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            audit: terminalAudit,
          },
          { agentDir: options.agentDir, startedAt: invocation.startedAt },
        );
        await acknowledgeSelfImproveRunAudit({
          agentDir: options.agentDir,
          handle: auditHandle!,
          reference: terminalAudit,
        });
        if (error && typeof error === "object") {
          Object.assign(error, { selfImproveAuditHistoryCommitted: true });
        }
      }
      throw error;
    }
  } finally {
    if (maintenanceLock) {
      await releaseSelfImproveMaintenanceLock(
        options.agentDir,
        maintenanceLock,
      );
    }
  }
}

export function applyCronTaskTerminalProjection(
  task: CronTaskRecord,
  terminal: CronTaskTerminal,
) {
  if (terminal.status === "completed") {
    task.lastResultText = terminal.text;
    task.lastError = undefined;
  } else {
    task.lastError = terminal.error || "cron_task_failed";
  }
  task.lastFinishedAt = nowIso();
  task.updatedAt = nowIso();
  if (
    !task.completedAt &&
    !task.trigger.expression &&
    task.runCount >= 1 &&
    !task.nextRunAt
  ) {
    task.completedAt = nowIso();
    task.completionReason = "once_completed";
    task.enabled = false;
    task.nextRunAt = undefined;
  }
  if (
    !task.completedAt &&
    task.termination?.maxRuns &&
    task.runCount >= task.termination.maxRuns
  ) {
    task.completedAt = nowIso();
    task.completionReason = "max_runs_reached";
    task.enabled = false;
    task.nextRunAt = undefined;
  }
  if (!task.completedAt && task.termination?.stopAt) {
    const stopTs = Date.parse(task.termination.stopAt);
    if (Number.isFinite(stopTs) && Date.now() >= stopTs) {
      task.completedAt = nowIso();
      task.completionReason = "stop_time_reached";
      task.enabled = false;
      task.nextRunAt = undefined;
    }
  }
}

export async function appendCronTaskTerminalHistory(
  task: CronTaskRecord,
  terminal: CronTaskTerminal,
  options: { agentDir: string; startedAt?: string },
) {
  const write = appendCronMaintenanceHistoryRecord(options.agentDir, task, {
    status: terminal.status,
    outputPreview: terminal.text,
    error: terminal.error,
    sessionFile: terminal.sessionFile,
    audit: terminal.audit,
    startedAt: options.startedAt,
    finishedAt: nowIso(),
  });
  if (terminal.audit) await write;
  else await write.catch(() => {});
}

export async function projectCronTaskTerminal(
  task: CronTaskRecord,
  terminal: CronTaskTerminal,
  options: { agentDir: string; startedAt?: string },
) {
  if (terminal.audit && !terminal.historyCommitted) {
    await appendCronTaskTerminalHistory(task, terminal, options);
  }
  applyCronTaskTerminalProjection(task, terminal);
  if (!terminal.audit && !terminal.historyCommitted) {
    await appendCronTaskTerminalHistory(task, terminal, options);
  }
}

export async function executeCronTask(
  task: CronTaskRecord,
  options: {
    agentDir: string;
    additionalExtensionPaths?: string[];
    chat?: CronChatCapability;
  },
) {
  const startedAt = task.lastStartedAt || nowIso();
  const runId = cronTaskRunId(task, startedAt);
  const showExternalWorking = task.target.kind === "shell_command";
  const audited = isSelfImproveDistillationTask(task);
  const maintenanceLock = audited
    ? await acquireSelfImproveMaintenanceLock(options.agentDir)
    : null;
  if (audited && !maintenanceLock) {
    throw new Error("self_improve_maintenance_lock_timeout");
  }
  let terminal: CronTaskTerminal | undefined;
  let executionCompleted = false;
  let auditCompleted = false;
  let auditHandle: SelfImproveRunAuditHandle | undefined;
  try {
    auditHandle = audited
      ? await beginSelfImproveRunAudit({
          agentDir: options.agentDir,
          runId: `${task.id}:${task.runCount}`,
          kind: "cron",
          startedAt,
          source: { trigger: `cron:${task.id}` },
        })
      : undefined;
    if (auditHandle?.completedPath) {
      executionCompleted = true;
      const audit = await completeSelfImproveRunAudit({
        agentDir: options.agentDir,
        handle: auditHandle,
        status: "completed",
        finishedAt: nowIso(),
      });
      auditCompleted = true;
      const exactEvidence = audit.evidenceRetained !== false && audit.complete;
      if (audit.status === "failed") {
        const error = new Error(
          exactEvidence
            ? audit.error || "self_improve_audit_recovered_failure"
            : "self_improve_audit_recovered_incomplete_failure",
        );
        Object.assign(error, { selfImproveAudit: audit });
        throw error;
      }
      terminal = {
        status: "completed",
        text: summarizeText(
          exactEvidence
            ? audit.output || ""
            : "Self-improve run already completed; exact terminal output evidence was redacted or truncated.",
          4_000,
        ),
        audit,
      };
    } else {
      if (auditHandle?.executionInterrupted) {
        throw new Error("self_improve_audit_interrupted_execution");
      }
      if (auditHandle) {
        await markSelfImproveRunAuditExecutionStarted({
          agentDir: options.agentDir,
          handle: auditHandle,
        });
      }
      if (showExternalWorking) {
        await setCronTaskFrontendWorking(task, options, true);
      }
      if (task.target.kind === "shell_command") {
        const text = await executeCronShellTask(task, {
          agentDir: options.agentDir,
        });
        terminal = { status: "completed", text };
        const frontend = resolveCronTaskFrontend(task);
        const chatKey = shouldDeliverCronTaskFinal(task, frontend)
          ? frontend?.key
          : undefined;
        if (chatKey && text) {
          await sendChatText(options, {
            chatKey,
            taskId: task.id,
            runId,
            text,
          }).catch(() => {});
        }
      } else {
        const result = await executeCronAgentTask(task, { ...options, runId });
        executionCompleted = true;
        const audit = auditHandle
          ? await completeSelfImproveRunAudit({
              agentDir: options.agentDir,
              handle: auditHandle,
              status: "completed",
              finishedAt: nowIso(),
              output: result.auditOutput,
            })
          : undefined;
        auditCompleted = Boolean(audit);
        terminal = {
          status: "completed",
          text: result.text,
          sessionFile: result.sessionFile,
          audit,
        };
      }
    }
  } catch (error: any) {
    if (audited && !auditHandle) throw error;
    if (audited && executionCompleted && !auditCompleted) throw error;
    const errorText = String(
      error?.message || error || "cron_task_failed",
    ).trim();
    const audit =
      error?.selfImproveAudit ||
      (auditHandle && !auditCompleted
        ? await completeSelfImproveRunAudit({
            agentDir: options.agentDir,
            handle: auditHandle,
            status: "failed",
            finishedAt: nowIso(),
            error: errorText,
          })
        : undefined);
    terminal = {
      status: "failed",
      error: errorText,
      audit,
    };
  } finally {
    try {
      if (showExternalWorking) {
        await setCronTaskFrontendWorking(task, options, false);
      }
      if (terminal) {
        await projectCronTaskTerminal(task, terminal, {
          agentDir: options.agentDir,
          startedAt,
        });
        if (terminal.audit && auditHandle) {
          await acknowledgeSelfImproveRunAudit({
            agentDir: options.agentDir,
            handle: auditHandle,
            reference: terminal.audit,
          });
        }
      }
    } finally {
      if (maintenanceLock) {
        await releaseSelfImproveMaintenanceLock(
          options.agentDir,
          maintenanceLock,
        );
      }
    }
  }
}
