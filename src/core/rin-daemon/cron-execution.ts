import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME_DIR = os.homedir();

import { listChatMessages } from "../chat/message-store.js";
import type { ChatOutboxPayload } from "../rin-lib/chat-outbox.js";
import {
  MANAGED_TASK_SESSION_LEAF,
  getManagedTaskSessionFile,
} from "../session/managed-paths.js";
import { resolveTurnCompletion } from "../session/turn-result.js";
import { cronTaskRunId, nowIso, summarizeText } from "./cron-utils.js";
import { normalizeScheduledTaskSessionMode } from "../scheduled-task-options.js";
import { maintenanceHistoryPath } from "../self-improve/paths.js";
import { resolveStoredSessionFile } from "../session/ref.js";
import type { CronTaskFrontendBinding, CronTaskRecord } from "./cron.js";

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
    type: "text_delivery",
    createdAt: nowIso(),
    ...payload,
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

function resolveCronTaskFrontend(task: CronTaskRecord) {
  const frontend = (task as any).frontend as
    | CronTaskFrontendBinding
    | undefined;
  const key = String(frontend?.key || "").trim();
  if (!key) return undefined;
  const kind = String(frontend?.kind || "").trim() || undefined;
  return {
    key,
    ...(kind ? { kind } : {}),
    deliverFinal: (frontend as any).deliverFinal !== false,
  };
}

function cronTaskRunControllerKey(task: CronTaskRecord) {
  const frontend = resolveCronTaskFrontend(task);
  return frontend && frontend.kind !== "chat" ? frontend.key : task.id;
}

function shouldDeliverCronTaskFinal(
  frontend: ReturnType<typeof resolveCronTaskFrontend>,
) {
  return frontend?.kind === "chat" && frontend.deliverFinal !== false;
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

function buildCronTaskPromptContext(task: CronTaskRecord) {
  const taskName = String(task.name || "").trim();
  const frontend = resolveCronTaskFrontend(task);
  return {
    source: frontend?.kind === "chat" ? "chat-bridge" : "scheduled-task",
    sentAt: Date.now(),
    ...(frontend?.kind === "chat" ? { chatKey: frontend.key } : {}),
    frontend,
    taskId: task.id,
    taskName: taskName || undefined,
  };
}

function buildCronSessionInstructionPromptContext(
  task: CronTaskRecord,
  chatKey: string,
) {
  const taskName = String(task.name || "").trim();
  return {
    source: "scheduled-task",
    sentAt: Date.now(),
    chatKey,
    taskId: task.id,
    taskName: taskName || undefined,
    scheduledTaskInitiator: "agent",
  };
}

function chatMessageTimestamp(record: any) {
  return (
    Date.parse(String(record?.processedAt || record?.receivedAt || "")) || 0
  );
}

export function resolveCronSessionInstructionChatKey(
  agentDir: string,
  sessionFile: string,
) {
  const resolvedSessionFile = resolveStoredSessionFile(agentDir, sessionFile);
  if (!resolvedSessionFile) throw new Error("cron_session_file_required");
  if (!existsSync(resolvedSessionFile)) {
    throw new Error("cron_session_file_not_found");
  }
  const matched = listChatMessages(agentDir)
    .filter((record) => {
      const recordSessionFile = resolveStoredSessionFile(
        agentDir,
        record?.sessionFile,
      );
      return (
        recordSessionFile &&
        path.resolve(recordSessionFile) === path.resolve(resolvedSessionFile) &&
        String(record?.chatKey || "").trim()
      );
    })
    .sort((a, b) => chatMessageTimestamp(b) - chatMessageTimestamp(a))[0];
  const chatKey = String(matched?.chatKey || "").trim();
  if (!chatKey)
    throw new Error("cron_session_instruction_chat_binding_not_found");
  return { chatKey, sessionFile: resolvedSessionFile };
}

function isSelfImproveExtractionTask(task: CronTaskRecord) {
  if (task.id === "builtin_self_improve_sleep_consolidation_daily") return true;
  if (task.target.kind !== "agent_prompt") return false;
  const prompt = [task.target.prompt, task.target.continuationPrompt]
    .map((value) => String(value || ""))
    .join("\n");
  return prompt.includes("self-improve-memory-maintenance.md");
}

function shouldShutdownTaskSessionAfterRun(
  task: CronTaskRecord,
  sessionMode: string,
) {
  return sessionMode === "none" && !isSelfImproveExtractionTask(task);
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
  if (!isSelfImproveExtractionTask(task)) return;
  const filePath = maintenanceHistoryPath(agentDir);
  await mkdir(path.dirname(filePath), { recursive: true });
  await appendFile(
    filePath,
    `${JSON.stringify({
      id: `${task.id}:${task.runCount}`,
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
  const sessionFile = await resolveCronSessionFile(task);
  const continuing = Boolean(
    sessionMode === "dedicated" && (sessionFile || task.runCount > 1),
  );
  const basePrompt = continuing
    ? String(task.target.continuationPrompt || "").trim()
    : String(task.target.prompt || "").trim();
  if (!basePrompt) throw new Error("cron_prompt_required");
  const prompt = basePrompt;
  const result = await options.chat.runTurn({
    controllerKey,
    affectChatBinding: false,
    disposeAfterTurn: sessionMode === "none",
    shutdownAfterTurn: shouldShutdownTaskSessionAfterRun(task, sessionMode),
    text: prompt,
    sessionFile: sessionFile || dedicatedSessionFile,
    ...(sessionMode === "none"
      ? { managedSessionLeaf: MANAGED_TASK_SESSION_LEAF }
      : {}),
    ...(task.model ? { model: task.model } : {}),
    ...(task.thinkingLevel ? { thinkingLevel: task.thinkingLevel } : {}),
    ...(frontend
      ? {
          frontend: {
            kind: frontend.kind || "scheduled-task",
            key: frontend.key,
          },
          promptMeta: buildCronTaskPromptContext(task),
        }
      : {}),
  });
  const completion = resolveTurnCompletion(result);
  const finalText = summarizeText(completion.finalText, 4000);
  if (!finalText) throw new Error("cron_final_assistant_text_missing");
  const nextSessionFile = String(result?.sessionFile || "").trim() || undefined;
  const keepChatBoundSession = Boolean(chatKey && nextSessionFile);
  const keepSelfImproveSession = Boolean(
    isSelfImproveExtractionTask(task) && nextSessionFile,
  );
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
        ? keepChatBoundSession || keepSelfImproveSession
          ? nextSessionFile
          : undefined
        : dedicatedSessionFile,
  };
}

export async function executeCronSessionInstructionTask(
  task: CronTaskRecord,
  options: {
    agentDir: string;
    additionalExtensionPaths?: string[];
    chat?: CronChatCapability;
    runId?: string;
  },
) {
  if ((task.session as any)?.mode !== "session_instruction") {
    throw new Error("cron_invalid_session_instruction_task");
  }
  if (task.target.kind !== "agent_prompt") {
    throw new Error("cron_session_instruction_requires_agent_prompt");
  }
  if (typeof options.chat?.runTurn !== "function") {
    throw new Error("cron_chat_unavailable");
  }
  const instruction = String(task.target.prompt || "").trim();
  if (!instruction) throw new Error("cron_prompt_required");
  const { chatKey, sessionFile } = resolveCronSessionInstructionChatKey(
    options.agentDir,
    (task.session as any).sessionFile || "",
  );
  const result = await options.chat.runTurn({
    chatKey,
    affectChatBinding: true,
    disposeAfterTurn: false,
    deliverFinal: task.deliverFinal !== false,
    text: instruction,
    sessionFile,
    ...(task.model ? { model: task.model } : {}),
    ...(task.thinkingLevel ? { thinkingLevel: task.thinkingLevel } : {}),
    promptMeta: buildCronSessionInstructionPromptContext(task, chatKey),
  });
  const completion = resolveTurnCompletion(result);
  const finalText = summarizeText(completion.finalText, 4000);
  if (!finalText) throw new Error("cron_final_assistant_text_missing");
  return {
    text: finalText,
    sessionId: String(result?.sessionId || "").trim() || undefined,
    sessionFile: String(result?.sessionFile || "").trim() || undefined,
  };
}

export async function executeCronTask(
  task: CronTaskRecord,
  options: {
    agentDir: string;
    additionalExtensionPaths?: string[];
    chat?: CronChatCapability;
  },
) {
  const runId = cronTaskRunId(task);
  const startedAt = task.lastStartedAt || nowIso();
  let maintenanceHistoryRecord:
    | {
        status: "completed" | "failed";
        outputPreview?: string;
        error?: string;
        sessionFile?: string;
      }
    | undefined;
  try {
    await setCronTaskFrontendWorking(task, options, true);
    if (task.target.kind === "shell_command") {
      const text = await executeCronShellTask(task, {
        agentDir: options.agentDir,
      });
      task.lastResultText = text;
      maintenanceHistoryRecord = {
        status: "completed",
        outputPreview: text,
      };
      const frontend = resolveCronTaskFrontend(task);
      const chatKey = shouldDeliverCronTaskFinal(frontend)
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
    } else if ((task.session as any)?.mode === "session_instruction") {
      const result = await executeCronSessionInstructionTask(task, {
        ...options,
        runId,
      });
      task.lastResultText = result.text;
      maintenanceHistoryRecord = {
        status: "completed",
        outputPreview: result.text,
        sessionFile: result.sessionFile,
      };
    } else {
      const result = await executeCronAgentTask(task, { ...options, runId });
      task.lastResultText = result.text;
      maintenanceHistoryRecord = {
        status: "completed",
        outputPreview: result.text,
        sessionFile: result.sessionFile,
      };
      const frontend = resolveCronTaskFrontend(task);
      const chatKey = shouldDeliverCronTaskFinal(frontend)
        ? frontend?.key
        : undefined;
      if (chatKey && result.text) {
        await sendChatText(options, {
          chatKey,
          taskId: task.id,
          runId,
          text: result.text,
          sessionFile: result.sessionFile,
        }).catch(() => {});
      }
    }
  } catch (error: any) {
    task.lastError = String(
      error?.message || error || "cron_task_failed",
    ).trim();
    maintenanceHistoryRecord = {
      status: "failed",
      error: task.lastError,
    };
  } finally {
    await setCronTaskFrontendWorking(task, options, false);
    task.lastFinishedAt = nowIso();
    task.updatedAt = nowIso();
    if (maintenanceHistoryRecord) {
      await appendCronMaintenanceHistoryRecord(options.agentDir, task, {
        ...maintenanceHistoryRecord,
        startedAt,
        finishedAt: task.lastFinishedAt,
      }).catch(() => {});
    }
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
}
