import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
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
import { maintenanceHistoryPath } from "../self-improve/paths.js";
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
  },
) {
  if (!isSelfImproveDistillationTask(task)) return;
  const filePath = maintenanceHistoryPath(agentDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  const recordId = `${task.id}:${task.runCount}`;
  const existing = await readFile(filePath, "utf8").catch(() => "");
  if (
    existing
      .split("\n")
      .filter(Boolean)
      .some((line) => {
        try {
          return JSON.parse(line)?.id === recordId;
        } catch {
          return false;
        }
      })
  ) {
    return;
  }
  await appendFile(
    filePath,
    `${JSON.stringify({
      id: recordId,
      kind: "self_improve_review",
      status: record.status,
      trigger: `cron:${task.id}`,
      sessionFile: record.sessionFile,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      attempts: 1,
      outputPreview: record.outputPreview
        ? summarizeText(record.outputPreview, 800)
        : undefined,
      error: record.error,
    })}\n`,
    "utf8",
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
          affectChatBinding: true,
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
  const finalText = summarizeText(completion.finalText, 4000);
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
  return await executeCronAgentTask(task, {
    ...options,
    runId: invocation.requestTag,
    sessionFile: invocation.sessionFile,
    promptMeta: invocation.promptMeta,
    deliveryIdempotencyKey: `scheduled-final:${invocation.id}`,
    continuing: invocation.continuing,
  });
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
  await appendCronMaintenanceHistoryRecord(options.agentDir, task, {
    status: terminal.status,
    outputPreview: terminal.text,
    error: terminal.error,
    sessionFile: terminal.sessionFile,
    startedAt: options.startedAt,
    finishedAt: task.lastFinishedAt || nowIso(),
  }).catch(() => {});
}

export async function projectCronTaskTerminal(
  task: CronTaskRecord,
  terminal: CronTaskTerminal,
  options: { agentDir: string; startedAt?: string },
) {
  applyCronTaskTerminalProjection(task, terminal);
  await appendCronTaskTerminalHistory(task, terminal, options);
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
  let terminal: CronTaskTerminal;
  try {
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
      terminal = {
        status: "completed",
        text: result.text,
        sessionFile: result.sessionFile,
      };
    }
  } catch (error: any) {
    terminal = {
      status: "failed",
      error: String(error?.message || error || "cron_task_failed").trim(),
    };
  } finally {
    if (showExternalWorking) {
      await setCronTaskFrontendWorking(task, options, false);
    }
  }
  await projectCronTaskTerminal(task, terminal!, {
    agentDir: options.agentDir,
    startedAt,
  });
}
