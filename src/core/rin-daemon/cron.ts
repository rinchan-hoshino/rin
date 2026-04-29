import fs from "node:fs";
import path from "node:path";

import { cloneJson } from "../json-utils.js";
import {
  ALL_THINKING_LEVELS,
  type AvailableThinkingLevel,
} from "../model-thinking-levels.js";
import { readJsonFile, writeJsonAtomic } from "../platform/fs.js";
import { safeString } from "../platform/process.js";
import { shellQuote } from "../rin-lib/system.js";
import {
  normalizeScheduledTaskSessionMode,
  type ScheduledTaskSessionMode,
  type ScheduledTaskTargetKind,
} from "../scheduled-task-options.js";
import { getManagedTaskSessionFile } from "../session/managed-paths.js";
import { executeCronTask } from "./cron-execution.js";
import {
  computeNextRunAt,
  createCronTaskId,
  cronTasksPath,
  nextCronAt,
  normalizeIso,
  nowIso,
} from "./cron-utils.js";

export type CronTaskTarget =
  | {
      kind: Extract<ScheduledTaskTargetKind, "agent_prompt">;
      prompt?: string;
      continuationPrompt?: string;
    }
  | {
      kind: Extract<ScheduledTaskTargetKind, "shell_command">;
      command: string;
    };

export type CronTaskTrigger = {
  intervalMs?: number;
  startAt?: string;
  expression?: string;
  timezone?: "local";
  runAt?: string;
};

export type CronTaskTermination = {
  maxRuns?: number;
  stopAt?: string;
};

export type CronTaskSessionBinding = {
  mode: ScheduledTaskSessionMode;
};

export type CronTaskThinkingLevel = AvailableThinkingLevel;

export type CronTaskRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  builtIn?: boolean;
  createdFrom?: {
    sessionFile?: string;
    sessionId?: string;
    sessionName?: string;
    chatKey?: string;
  };
  name?: string;
  enabled: boolean;
  completedAt?: string;
  completionReason?: string;
  pausedAt?: string;
  chatKey?: string;
  model?: string;
  thinkingLevel?: CronTaskThinkingLevel;
  trigger: CronTaskTrigger;
  termination?: CronTaskTermination;
  session: CronTaskSessionBinding;
  target: CronTaskTarget;
  dedicatedSessionFile?: string;
  dedicatedSessionPersistent?: boolean;
  nextRunAt?: string;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastResultText?: string;
  lastError?: string;
  runCount: number;
  running: boolean;
  activeStartedAt?: string;
  activeDurationMs?: number;
};

export type CronTaskInput = {
  id?: string;
  name?: string;
  enabled?: boolean;
  chatKey?: string | null;
  model?: string;
  thinkingLevel?: CronTaskThinkingLevel;
  trigger?: CronTaskTrigger;
  termination?: CronTaskTermination | null;
  session?: CronTaskSessionBinding;
  target?: CronTaskTarget;
};

type CronTaskUpsertDefaults = {
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  chatKey?: string;
};

function normalizeThinkingLevel(
  value: unknown,
): CronTaskThinkingLevel | undefined {
  const level = safeString(value).trim();
  return ALL_THINKING_LEVELS.includes(level as CronTaskThinkingLevel)
    ? (level as CronTaskThinkingLevel)
    : undefined;
}

function normalizeModelOverride(value: unknown) {
  return safeString(value).trim() || undefined;
}

function failCronTaskValidation(errorCode: string): never {
  throw new Error(errorCode);
}

function requireNonEmptyString(value: unknown, errorCode: string) {
  const text = safeString(value).trim();
  if (!text) failCronTaskValidation(errorCode);
  return text;
}

function normalizeTaskTrigger(trigger: CronTaskTrigger | undefined) {
  if (!trigger) throw new Error("cron_trigger_required");
  const expression = safeString((trigger as any).expression).trim();
  const intervalMs = Number((trigger as any).intervalMs || 0);
  if (expression) {
    return {
      expression,
      timezone: "local" as const,
    };
  }
  if (intervalMs > 0) {
    return {
      intervalMs: Math.max(1_000, intervalMs),
      startAt: normalizeIso((trigger as any).startAt, "startAt"),
    };
  }
  return {
    runAt:
      normalizeIso(
        (trigger as any).runAt || (trigger as any).startAt,
        "runAt",
      ) || failCronTaskValidation("cron_runAt_required"),
  };
}

function normalizeTaskSession(session: CronTaskSessionBinding | undefined) {
  const requestedMode = normalizeScheduledTaskSessionMode(
    session?.mode || "none",
  );
  if (!requestedMode) {
    throw new Error(
      `cron_invalid_session_mode:${safeString((session as any)?.mode).trim() || "unknown"}`,
    );
  }
  const normalizedSession: CronTaskSessionBinding = { mode: requestedMode };
  return { normalizedSession };
}

function normalizeTaskTarget(target: CronTaskTarget | undefined) {
  if (!target) throw new Error("cron_target_required");
  if (target.kind === "agent_prompt") {
    const prompt = safeString(target.prompt).trim();
    const continuationPrompt = safeString(target.continuationPrompt).trim();
    if (!prompt) failCronTaskValidation("cron_prompt_required");
    return {
      kind: "agent_prompt" as const,
      prompt,
      continuationPrompt: continuationPrompt || undefined,
    };
  }
  return {
    kind: "shell_command" as const,
    command: requireNonEmptyString(target.command, "cron_command_required"),
  };
}

function normalizeTaskTermination(
  termination: CronTaskTermination | null | undefined,
  existing: CronTaskRecord | undefined,
) {
  return termination === null
    ? undefined
    : termination !== undefined
      ? {
          maxRuns: termination.maxRuns
            ? Math.max(1, Number(termination.maxRuns))
            : undefined,
          stopAt: normalizeIso(termination.stopAt, "stopAt"),
        }
      : existing?.termination;
}

function resolveDedicatedSessionBinding(options: {
  agentDir: string;
  taskId: string;
  session: CronTaskSessionBinding;
}) {
  if (options.session.mode !== "dedicated") {
    return {
      dedicatedSessionFile: undefined,
      dedicatedSessionPersistent: undefined,
    };
  }
  return {
    dedicatedSessionFile: getManagedTaskSessionFile(
      options.agentDir,
      options.taskId,
    ),
    dedicatedSessionPersistent: true,
  };
}

function createBuiltInMemoryIndexRepairTask(agentDir: string): CronTaskRecord {
  const createdAt = nowIso();
  const command = `${shellQuote(process.execPath)} ${shellQuote(path.join(agentDir, "app", "current", "dist", "app", "rin", "main.js"))} memory-index repair`;
  const task: CronTaskRecord = {
    id: "builtin_memory_index_repair_daily",
    builtIn: true,
    createdAt,
    updatedAt: createdAt,
    name: "Repair memory search index",
    enabled: true,
    trigger: {
      expression: "17 4 * * *",
      timezone: "local",
    },
    session: { mode: "none" },
    target: { kind: "shell_command", command },
    runCount: 0,
    running: false,
  };
  task.nextRunAt = computeNextRunAt(task, Date.now());
  return task;
}

function mergeBuiltInTaskState(
  existing: CronTaskRecord | undefined,
  builtin: CronTaskRecord,
): CronTaskRecord {
  if (!existing) return builtin;
  const merged: CronTaskRecord = {
    ...builtin,
    createdAt: safeString(existing.createdAt).trim() || builtin.createdAt,
    updatedAt: safeString(existing.updatedAt).trim() || builtin.updatedAt,
    lastStartedAt: existing.lastStartedAt,
    lastFinishedAt: existing.lastFinishedAt,
    lastResultText: existing.lastResultText,
    lastError: existing.lastError ? safeString(existing.lastError) : undefined,
    runCount: Number(existing.runCount || 0),
    nextRunAt:
      safeString(existing.nextRunAt).trim() ||
      computeNextRunAt(builtin, Date.now()),
    running: false,
  };
  return merged;
}

function assertMutableTask(task: CronTaskRecord | undefined) {
  if (!task) return;
  if (task.builtIn) throw new Error(`cron_builtin_task_protected:${task.id}`);
}

export class CronScheduler {
  private tasks = new Map<string, CronTaskRecord>();
  private activeExecutions = new Map<string, { startedAt: number }>();
  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;

  constructor(
    private options: {
      agentDir: string;
      additionalExtensionPaths?: string[];
      chat?: {
        send?: (payload: any) => Promise<any>;
        runTurn?: (payload: any) => Promise<any>;
        terminateTurn?: (payload: { controllerKey: string }) => Promise<any>;
      };
    },
  ) {}

  start() {
    this.load();
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 1000);
    void this.tick().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.save();
  }

  listTasks(options: { includeBuiltIn?: boolean } = {}) {
    return Array.from(this.tasks.values())
      .filter((task) => options.includeBuiltIn || !task.builtIn)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((task) => this.publicTask(task));
  }

  getTask(taskId: string, options: { includeBuiltIn?: boolean } = {}) {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    if (!options.includeBuiltIn && task.builtIn) return undefined;
    return this.publicTask(task);
  }

  getStatusSnapshot(options: { includeBuiltIn?: boolean } = {}) {
    const tasks = Array.from(this.tasks.values())
      .filter((task) => options.includeBuiltIn || !task.builtIn)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
      .map((task) => this.statusTask(task));
    const runningTaskCount = tasks.filter((task) => task.running).length;
    const enabledTaskCount = tasks.filter(
      (task) => task.enabled && !task.completedAt,
    ).length;
    const nextRunAt = tasks
      .map((task) => safeString(task.nextRunAt).trim())
      .filter(Boolean)
      .sort()[0];
    return {
      taskCount: tasks.length,
      enabledTaskCount,
      runningTaskCount,
      builtInTaskCount: Array.from(this.tasks.values()).filter(
        (task) => task.builtIn,
      ).length,
      nextRunAt,
      tasks,
    };
  }

  upsertTask(input: CronTaskInput, defaults: CronTaskUpsertDefaults = {}) {
    const existing = input.id ? this.tasks.get(String(input.id)) : undefined;
    assertMutableTask(existing);
    const id =
      existing?.id || safeString(input.id).trim() || createCronTaskId();
    const createdAt = existing?.createdAt || nowIso();
    const updatedAt = nowIso();
    const name =
      input.name !== undefined
        ? safeString(input.name).trim() || undefined
        : existing?.name;
    const chatKey =
      input.chatKey === null
        ? undefined
        : input.chatKey !== undefined
          ? safeString(input.chatKey).trim() || undefined
          : existing?.chatKey;

    const normalizedTrigger = normalizeTaskTrigger(
      input.trigger ?? existing?.trigger,
    );
    const { normalizedSession } = normalizeTaskSession(
      input.session ?? existing?.session,
    );
    const session = normalizedSession;
    const model =
      input.model !== undefined
        ? normalizeModelOverride(input.model)
        : existing?.model;
    const thinkingLevel = normalizeThinkingLevel(
      input.thinkingLevel !== undefined
        ? input.thinkingLevel
        : existing?.thinkingLevel,
    );
    const normalizedTarget = normalizeTaskTarget(
      input.target ?? existing?.target,
    );
    const { dedicatedSessionFile, dedicatedSessionPersistent } =
      resolveDedicatedSessionBinding({
        agentDir: this.options.agentDir,
        taskId: id,
        session,
      });
    const termination = normalizeTaskTermination(input.termination, existing);

    const enabled =
      input.enabled !== undefined
        ? Boolean(input.enabled)
        : (existing?.enabled ?? true);
    const task: CronTaskRecord = {
      id,
      createdAt,
      updatedAt,
      createdFrom: existing?.createdFrom || {
        sessionFile: defaults.sessionFile,
        sessionId: defaults.sessionId,
        sessionName: defaults.sessionName,
        chatKey: defaults.chatKey,
      },
      name,
      enabled,
      completedAt: existing?.completedAt,
      completionReason: existing?.completionReason,
      pausedAt: existing?.pausedAt,
      chatKey,
      model,
      thinkingLevel,
      trigger: normalizedTrigger,
      termination,
      session: normalizedSession,
      target: normalizedTarget,
      dedicatedSessionFile,
      dedicatedSessionPersistent,
      lastStartedAt: existing?.lastStartedAt,
      lastFinishedAt: existing?.lastFinishedAt,
      lastResultText: existing?.lastResultText,
      lastError: existing?.lastError,
      runCount: existing?.runCount ?? 0,
      running: false,
    };

    task.nextRunAt = computeNextRunAt(task, Date.now());

    if (task.completedAt) {
      task.enabled = false;
      task.nextRunAt = undefined;
    }

    this.tasks.set(task.id, task);
    this.save();
    return this.publicTask(task);
  }

  deleteTask(taskId: string) {
    const task = this.tasks.get(taskId);
    assertMutableTask(task);
    const ok = this.tasks.delete(taskId);
    if (ok) {
      this.terminateTaskSession(task);
      this.save();
    }
    return ok;
  }

  completeTask(taskId: string, reason = "completed_by_agent") {
    const task = this.tasks.get(taskId);
    assertMutableTask(task);
    if (!task) throw new Error(`cron_task_not_found:${taskId}`);
    task.completedAt = nowIso();
    task.completionReason = safeString(reason).trim() || "completed";
    task.enabled = false;
    task.nextRunAt = undefined;
    task.updatedAt = nowIso();
    this.terminateTaskSession(task);
    this.save();
    return this.publicTask(task);
  }

  pauseTask(taskId: string) {
    const task = this.tasks.get(taskId);
    assertMutableTask(task);
    if (!task) throw new Error(`cron_task_not_found:${taskId}`);
    task.enabled = false;
    task.pausedAt = nowIso();
    task.nextRunAt = undefined;
    task.updatedAt = nowIso();
    this.terminateTaskSession(task);
    this.save();
    return this.publicTask(task);
  }

  resumeTask(taskId: string) {
    const task = this.tasks.get(taskId);
    assertMutableTask(task);
    if (!task) throw new Error(`cron_task_not_found:${taskId}`);
    task.enabled = true;
    delete task.pausedAt;
    task.nextRunAt = computeNextRunAt(task, Date.now());
    task.updatedAt = nowIso();
    this.save();
    return this.publicTask(task);
  }

  private load() {
    const file = cronTasksPath(this.options.agentDir);
    const rows = readJsonFile<CronTaskRecord[]>(file, []);
    this.tasks.clear();
    for (const row of rows) {
      if (!row || typeof row !== "object" || !row.id) continue;
      row.running = false;
      row.lastError = row.lastError ? safeString(row.lastError) : undefined;
      row.thinkingLevel = normalizeThinkingLevel(row.thinkingLevel);
      row.model = normalizeModelOverride(row.model);
      const normalizedMode = normalizeScheduledTaskSessionMode(
        (row.session as any)?.mode,
      );
      row.session = { mode: normalizedMode || "none" };
      row.trigger = normalizeTaskTrigger(row.trigger);
      if (row.session.mode === "dedicated") {
        row.dedicatedSessionPersistent = true;
        row.dedicatedSessionFile = getManagedTaskSessionFile(
          this.options.agentDir,
          row.id,
        );
      } else {
        delete row.dedicatedSessionFile;
        delete row.dedicatedSessionPersistent;
      }
      row.nextRunAt = row.completedAt
        ? undefined
        : row.nextRunAt || computeNextRunAt(row, Date.now());
      this.tasks.set(String(row.id), row);
    }
    this.installBuiltInTasks();
    this.save();
  }

  private snapshotTask(task: CronTaskRecord): CronTaskRecord {
    const activeExecution = this.activeExecutions.get(task.id);
    return {
      ...task,
      running: Boolean(activeExecution),
      activeStartedAt: activeExecution
        ? new Date(activeExecution.startedAt).toISOString()
        : undefined,
      activeDurationMs: activeExecution
        ? Math.max(0, Date.now() - activeExecution.startedAt)
        : undefined,
    };
  }

  private persistedTask(task: CronTaskRecord): CronTaskRecord {
    return {
      ...task,
      running: false,
      activeStartedAt: undefined,
      activeDurationMs: undefined,
    };
  }

  private publicTask(task: CronTaskRecord): CronTaskRecord {
    return cloneJson(this.snapshotTask(task));
  }

  private statusTask(task: CronTaskRecord) {
    const snapshot = this.snapshotTask(task);
    const {
      chatKey,
      createdFrom,
      dedicatedSessionFile,
      lastError,
      lastResultText,
      target,
      ...safeTask
    } = snapshot;
    void createdFrom;
    void dedicatedSessionFile;
    void lastError;
    void lastResultText;
    return cloneJson({
      ...safeTask,
      hasChatBinding: Boolean(chatKey),
      session: { mode: snapshot.session.mode },
      target: { kind: target.kind },
    });
  }

  private save() {
    writeJsonAtomic(
      cronTasksPath(this.options.agentDir),
      Array.from(this.tasks.values()).map((task) => this.persistedTask(task)),
    );
  }

  private installBuiltInTasks() {
    const builtin = createBuiltInMemoryIndexRepairTask(this.options.agentDir);
    const existing = this.tasks.get(builtin.id);
    this.tasks.set(builtin.id, mergeBuiltInTaskState(existing, builtin));
  }

  private async tick() {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const now = Date.now();
      const due = Array.from(this.tasks.values())
        .filter(
          (task) =>
            task.enabled &&
            !this.activeExecutions.has(task.id) &&
            !task.completedAt &&
            task.nextRunAt &&
            Date.parse(task.nextRunAt) <= now,
        )
        .sort(
          (a, b) =>
            Date.parse(String(a.nextRunAt || a.createdAt)) -
            Date.parse(String(b.nextRunAt || b.createdAt)),
        );
      for (const task of due) {
        this.activeExecutions.set(task.id, { startedAt: Date.now() });
        task.lastStartedAt = nowIso();
        task.runCount += 1;
        task.lastError = undefined;
        task.updatedAt = nowIso();
        if (task.trigger.intervalMs) {
          task.nextRunAt = computeNextRunAt(task, Date.now());
        } else if (task.trigger.expression) {
          task.nextRunAt = nextCronAt(task.trigger.expression, Date.now());
        } else {
          task.nextRunAt = undefined;
        }
        this.save();
        void this.executeTask(task).catch(() => {});
      }
    } finally {
      this.dispatching = false;
    }
  }

  private terminateTaskSession(task: CronTaskRecord | undefined) {
    if (!task || task.session.mode !== "dedicated") return;
    void this.options.chat
      ?.terminateTurn?.({ controllerKey: task.id })
      .catch(() => {});
  }

  private async executeTask(task: CronTaskRecord) {
    try {
      await executeCronTask(task, this.options);
      if (!task.completedAt && !task.trigger.intervalMs) {
        task.nextRunAt = computeNextRunAt(task, Date.now());
      }
      if (task.completedAt) this.terminateTaskSession(task);
    } finally {
      this.activeExecutions.delete(task.id);
      this.save();
    }
  }
}
