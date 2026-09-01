import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const HOME_DIR = os.homedir();

import { resolveChatQuietModeEnabled } from "../chat/settings.js";
import { readJsonFileOrDefault } from "../platform/fs.js";
import type { ChatOutboxPayload } from "../rin-lib/chat-outbox-contract.js";
import { resolveTurnCompletion } from "../session/turn-result.js";
import { cronTaskRunId, nowIso, summarizeText } from "./cron-utils.js";
import { safeString } from "../text-utils.js";
import type {
  CronSessionInvocation,
  CronTaskFrontendBinding,
  CronTaskRecord,
} from "./cron-contract.js";

type CronChatCapability = {
  send?: (
    payload: ChatOutboxPayload,
    options?: { waitForDeliveryMs?: number; idempotencyKey?: string },
  ) => Promise<any>;
  runTurn?: (payload: any) => Promise<any>;
  submitIncoming?: (payload: any) => Promise<any>;
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
    replyToMessageId?: string;
    waitForDeliveryMs?: number;
    idempotencyKey?: string;
  },
) {
  if (typeof options.chat?.send !== "function") {
    throw new Error("cron_chat_unavailable");
  }
  const parts: ChatOutboxPayload["parts"] = [
    ...(payload.replyToMessageId
      ? [{ type: "quote" as const, id: payload.replyToMessageId }]
      : []),
    { type: "text", text: payload.text },
  ];
  return await options.chat.send(
    {
      createdAt: nowIso(),
      chatKey: payload.chatKey,
      taskId: payload.taskId,
      runId: payload.runId,
      parts,
      ...(payload.sessionFile
        ? {
            sessionFile: payload.sessionFile,
            sessionBinding: "conversation" as const,
          }
        : {}),
    },
    Number.isFinite(payload.waitForDeliveryMs) || payload.idempotencyKey
      ? {
          ...(Number.isFinite(payload.waitForDeliveryMs)
            ? { waitForDeliveryMs: payload.waitForDeliveryMs }
            : {}),
          ...(payload.idempotencyKey
            ? { idempotencyKey: payload.idempotencyKey }
            : {}),
        }
      : undefined,
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

export const DEFAULT_CRON_SHELL_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_CRON_SHELL_TIMEOUT_MS = 100;
const MAX_CRON_SHELL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export function normalizeCronShellTimeoutMs(value: unknown) {
  if (value === undefined) return DEFAULT_CRON_SHELL_TIMEOUT_MS;
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("cron_shell_timeout_invalid");
  }
  return Math.min(
    MAX_CRON_SHELL_TIMEOUT_MS,
    Math.max(MIN_CRON_SHELL_TIMEOUT_MS, Math.round(timeoutMs)),
  );
}

function terminateCronShellProcess(child: ReturnType<typeof spawn>): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch (error: any) {
      if (error?.code === "ESRCH") return;
    }
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {}
}

export async function executeCronShellCommand(
  task: CronTaskRecord,
  options: { agentDir: string },
) {
  if (task.target.kind !== "shell_command")
    throw new Error("cron_invalid_shell_task");
  const { command } = task.target;
  const timeoutMs = normalizeCronShellTimeoutMs(task.target.timeoutMs);
  const { shell, args } = await getCronShellConfig(options.agentDir);
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(shell, [...args, command], {
      cwd: HOME_DIR,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      complete();
    };
    const timeout = setTimeout(() => {
      terminateCronShellProcess(child);
      child.stdout.destroy();
      child.stderr.destroy();
      settle(() =>
        reject(
          new Error(
            [
              `cron_shell_command_timeout:${timeoutMs}`,
              `Command: ${command}`,
              stdout.trim() ? `stdout:\n${summarizeText(stdout, 4000)}` : "",
              stderr.trim() ? `stderr:\n${summarizeText(stderr, 4000)}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          ),
        ),
      );
    }, timeoutMs);
    timeout.unref();
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => settle(() => reject(error)));
    child.on("close", (code, signal) => {
      const body = [
        `Command: ${command}`,
        `Exit: ${signal ? `signal ${signal}` : (code ?? 0)}`,
        stdout.trim() ? `stdout:\n${summarizeText(stdout, 4000)}` : "",
        stderr.trim() ? `stderr:\n${summarizeText(stderr, 4000)}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      settle(() => {
        if (code === 0 && !signal) resolve(body);
        else reject(new Error(body || "cron_command_failed"));
      });
    });
  });
}

function resolveCronTaskFrontend(task: Pick<CronTaskRecord, "frontend">) {
  const frontend = (task as any).frontend as
    | CronTaskFrontendBinding
    | undefined;
  const kind = String(frontend?.kind || "").trim() || undefined;
  if (kind === "tui") return { kind: "tui", key: "tui" };
  const key = String(frontend?.key || "").trim();
  if (!key) return undefined;
  return {
    key,
    ...(kind ? { kind } : {}),
  };
}

function cronTaskRunControllerKey(task: CronTaskRecord) {
  const frontend = resolveCronTaskFrontend(task);
  if (frontend?.kind === "chat") return "default";
  return frontend ? frontend.key || frontend.kind || task.id : task.id;
}

function shouldDeliverCronTaskFinal(
  task: CronTaskRecord,
  frontend: ReturnType<typeof resolveCronTaskFrontend>,
) {
  return task.quiet !== true && frontend?.kind === "chat";
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
    source: "scheduled-task" as const,
    sentAt,
    ...(frontend?.kind === "chat" ? { chatKey: frontend.key } : {}),
    frontend,
    taskId: task.id,
    taskName: taskName || undefined,
  };
}

export async function executeCronAgentTask(
  task: CronTaskRecord,
  options: {
    agentDir: string;
    additionalExtensionPaths?: string[];
    chat?: CronChatCapability;
    runId?: string;
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
  const frontend = resolveCronTaskFrontend(task);
  if (!frontend) throw new Error("cron_frontend_required");
  const chatKey = frontend.kind === "chat" ? frontend.key : undefined;
  const continuing =
    typeof options.continuing === "boolean"
      ? options.continuing
      : task.runCount > 1;
  const basePrompt = continuing
    ? String(task.target.continuationPrompt || task.target.prompt || "").trim()
    : String(task.target.prompt || "").trim();
  if (!basePrompt) throw new Error("cron_prompt_required");
  const prompt = basePrompt;
  const quiet = task.quiet === true;
  const chatQuiet = chatKey
    ? resolveChatQuietModeEnabled(
        readJsonFileOrDefault(path.join(options.agentDir, "settings.json"), {}),
        chatKey,
      )
    : false;
  const presentationQuiet = quiet || chatQuiet;
  let scheduledInputMessageId: string | undefined;
  if (chatKey && !presentationQuiet) {
    const presentationRunId = safeString(options.runId).trim();
    if (!presentationRunId) throw new Error("cron_run_id_required");
    const delivery = await sendChatText(options, {
      chatKey,
      taskId: task.id,
      runId: presentationRunId,
      text: scheduledTaskInputText(task, prompt),
      waitForDeliveryMs: 30_000,
      idempotencyKey: `scheduled-input:${presentationRunId}`,
    });
    scheduledInputMessageId =
      delivery?.delivered === true
        ? chatDeliveryMessageIds(delivery)[0]
        : undefined;
  }
  if (chatKey && !presentationQuiet && !scheduledInputMessageId) {
    throw new Error("cron_scheduled_input_delivery_failed");
  }
  const result =
    chatKey &&
    scheduledInputMessageId &&
    typeof options.chat?.submitIncoming === "function"
      ? await options.chat.submitIncoming({
          chatKey,
          messageId: scheduledInputMessageId,
          text: prompt,
          deliverFinal: !quiet,
          quietMode: presentationQuiet,
          ...(options.runId ? { requestTag: options.runId } : {}),
          ...(options.deliveryIdempotencyKey
            ? { deliveryIdempotencyKey: options.deliveryIdempotencyKey }
            : {}),
          promptMeta: options.promptMeta || buildCronTaskPromptContext(task),
        })
      : await options.chat.runTurn({
          controllerKey: chatKey ? "default" : cronTaskRunControllerKey(task),
          ...(chatKey ? { chatKey } : {}),
          ...(scheduledInputMessageId
            ? {
                incomingMessageId: scheduledInputMessageId,
                replyToMessageId: scheduledInputMessageId,
              }
            : {}),
          deliverFinal: !quiet,
          quietMode: presentationQuiet,
          text: prompt,
          ...(options.runId ? { requestTag: options.runId } : {}),
          ...(options.deliveryIdempotencyKey
            ? { deliveryIdempotencyKey: options.deliveryIdempotencyKey }
            : {}),
          frontend: { kind: frontend.kind, key: frontend.key },
          promptMeta: options.promptMeta || buildCronTaskPromptContext(task),
        });
  const completion = String(result?.turnId || "").trim()
    ? { finalText: "" }
    : resolveTurnCompletion(result);
  const finalText = summarizeText(completion.finalText, 4000);
  const nextSessionFile = String(result?.sessionFile || "").trim() || undefined;
  return {
    text: finalText,
    sessionId: String(result?.sessionId || "").trim() || undefined,
    sessionFile: nextSessionFile,
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
  _agentDir: string,
): CronSessionInvocation {
  if (task.target.kind !== "agent_prompt") {
    throw new Error("cron_invalid_agent_task");
  }
  const startedAt = task.lastStartedAt || nowIso();
  const id = cronTaskRunId(task, startedAt);
  const frontend = resolveCronTaskFrontend(task);
  if (!frontend) throw new Error("cron_frontend_required");
  return {
    id,
    requestTag: `scheduled:${id}`,
    taskId: task.id,
    runCount: task.runCount,
    startedAt,
    scheduledNextRunAt: task.nextRunAt,
    continuing: task.runCount > 1,
    name: task.name,
    frontend: { ...frontend },
    quiet: task.quiet === true,
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
    quiet: invocation.quiet === true,
    trigger: {},
    target: invocation.target,
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

export async function projectCronTaskTerminal(
  task: CronTaskRecord,
  terminal: CronTaskTerminal,
  _options: { agentDir: string; startedAt?: string },
) {
  applyCronTaskTerminalProjection(task, terminal);
}

export type CronShellTaskRecord = CronTaskRecord & {
  target: Extract<CronTaskRecord["target"], { kind: "shell_command" }>;
};

function scheduledTaskInputText(
  task: Pick<CronTaskRecord, "name">,
  text: string,
) {
  const taskName = safeString(task.name)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return [`⏰ Scheduled task${taskName ? ` · ${taskName}` : ""}`, text]
    .filter(Boolean)
    .join("\n");
}

function chatDeliveryMessageIds(result: unknown) {
  const value = result && typeof result === "object" ? (result as any) : null;
  const ids = Array.isArray(value?.messageIds)
    ? value.messageIds
    : Array.isArray(value?.deliveryResult)
      ? value.deliveryResult
      : [];
  return ids.map((id: unknown) => safeString(id).trim()).filter(Boolean);
}

export async function executeCronShellTask(
  task: CronShellTaskRecord,
  options: {
    agentDir: string;
    chat?: CronChatCapability;
  },
) {
  const startedAt = task.lastStartedAt || nowIso();
  const runId = cronTaskRunId(task, startedAt);
  const showExternalWorking = task.quiet !== true;
  const frontend = resolveCronTaskFrontend(task);
  const chatKey =
    showExternalWorking && frontend?.kind === "chat"
      ? safeString(frontend.key).trim()
      : "";
  let scheduledInputMessageId = "";
  let terminal: CronTaskTerminal;
  try {
    if (chatKey) {
      const delivery = await sendChatText(options, {
        chatKey,
        taskId: task.id,
        runId,
        text: scheduledTaskInputText(task, task.target.command),
        waitForDeliveryMs: 30_000,
        idempotencyKey: `scheduled-input:${runId}`,
      });
      scheduledInputMessageId =
        delivery?.delivered === true
          ? chatDeliveryMessageIds(delivery)[0] || ""
          : "";
      if (!scheduledInputMessageId) {
        throw new Error("cron_scheduled_input_delivery_failed");
      }
    }
    if (showExternalWorking) {
      await setCronTaskFrontendWorking(task, options, true);
    }
    const text = await executeCronShellCommand(task, {
      agentDir: options.agentDir,
    });
    terminal = { status: "completed", text };
    const deliveryChatKey = shouldDeliverCronTaskFinal(task, frontend)
      ? safeString(frontend?.key).trim()
      : "";
    if (deliveryChatKey && text) {
      await sendChatText(options, {
        chatKey: deliveryChatKey,
        taskId: task.id,
        runId,
        text,
        ...(scheduledInputMessageId
          ? { replyToMessageId: scheduledInputMessageId }
          : {}),
      }).catch(() => {});
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
  await projectCronTaskTerminal(task, terminal, {
    agentDir: options.agentDir,
    startedAt,
  });
}
