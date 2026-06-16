import fs from "node:fs";
import path from "node:path";

import { cloneJson } from "../json-utils.js";
import {
  ALL_THINKING_LEVELS,
  type AvailableThinkingLevel,
} from "../model-thinking-levels.js";
import { writeJsonAtomic } from "../platform/fs.js";
import { safeString } from "../platform/process.js";
import { shellQuote } from "../rin-lib/system.js";
import {
  normalizeScheduledTaskSessionMode,
  type ScheduledTaskSessionMode,
  type ScheduledTaskTargetKind,
} from "../scheduled-task-options.js";
import { getManagedTaskSessionFile } from "../session/managed-paths.js";
import { evaluateCronTaskCondition } from "./cron-condition.js";
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
  startAt?: string;
  expression?: string;
  timezone?: "local";
  runAt?: string;
};

export type CronTaskTermination = {
  maxRuns?: number;
  stopAt?: string;
};

export type CronTaskCondition = {
  code: string;
  timeoutMs?: number;
  lastEvaluatedAt?: string;
  lastResult?: boolean;
  lastOutput?: string;
};

export type CronTaskSessionBinding = {
  mode: ScheduledTaskSessionMode;
  sessionFile?: string;
};

export type CronTaskFrontendBinding = {
  kind?: string;
  key: string;
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
    frontend?: CronTaskFrontendBinding;
  };
  name?: string;
  enabled: boolean;
  completedAt?: string;
  completionReason?: string;
  pausedAt?: string;
  frontend?: CronTaskFrontendBinding;
  deliverFinal?: boolean;
  model?: string;
  thinkingLevel?: CronTaskThinkingLevel;
  disabledRinCapabilities?: string[];
  trigger: CronTaskTrigger;
  termination?: CronTaskTermination;
  condition?: CronTaskCondition;
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
  frontend?: CronTaskFrontendBinding | null;
  deliverFinal?: boolean;
  model?: string;
  thinkingLevel?: CronTaskThinkingLevel;
  disabledRinCapabilities?: string[] | null;
  trigger?: CronTaskTrigger;
  termination?: CronTaskTermination | null;
  condition?: CronTaskCondition | null;
  session?: CronTaskSessionBinding;
  target?: CronTaskTarget;
};

type CronTaskUpsertDefaults = {
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  frontend?: CronTaskFrontendBinding;
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

function normalizeDisabledRinCapabilities(
  value: unknown,
  existing: CronTaskRecord | undefined,
) {
  if (value === null) return undefined;
  if (value === undefined) return existing?.disabledRinCapabilities;
  const values = Array.isArray(value) ? value : [value];
  const normalized = [
    ...new Set(values.map((item) => safeString(item).trim()).filter(Boolean)),
  ];
  return normalized.length ? normalized : undefined;
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
  if (expression) {
    return {
      expression,
      timezone: "local" as const,
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
  if (requestedMode === "session_instruction") {
    normalizedSession.sessionFile = requireNonEmptyString(
      session?.sessionFile,
      "cron_session_file_required",
    );
  }
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

function normalizeTaskCondition(
  condition: CronTaskCondition | null | undefined,
  existing: CronTaskRecord | undefined,
): CronTaskCondition | undefined {
  if (condition === null) return undefined;
  if (condition === undefined) return existing?.condition;
  const code = requireNonEmptyString(
    condition.code,
    "cron_condition_code_required",
  );
  const timeoutMs = condition.timeoutMs
    ? Math.min(60_000, Math.max(100, Math.round(Number(condition.timeoutMs))))
    : undefined;
  return {
    code,
    timeoutMs,
    lastEvaluatedAt: existing?.condition?.lastEvaluatedAt,
    lastResult: existing?.condition?.lastResult,
    lastOutput: existing?.condition?.lastOutput,
  };
}

function normalizeTaskFrontend(
  frontend: CronTaskFrontendBinding | null | undefined,
  existing: CronTaskRecord | undefined,
): CronTaskFrontendBinding | undefined {
  if (frontend === null) return undefined;
  if (frontend === undefined) return existing?.frontend;
  const key = requireNonEmptyString(
    (frontend as any).key,
    "cron_frontend_key_required",
  );
  const kind = safeString((frontend as any).kind).trim() || undefined;
  return {
    ...(kind ? { kind } : {}),
    key,
  };
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
    name: "Repair recall index",
    enabled: true,
    trigger: {
      expression: "17 4 * * *",
      timezone: "local",
    },
    session: { mode: "none" },
    target: { kind: "shell_command", command },
    deliverFinal: true,
    runCount: 0,
    running: false,
  };
  task.nextRunAt = computeNextRunAt(task, Date.now());
  return task;
}

function createBuiltInSelfImproveSleepConsolidationTask(
  agentDir: string,
): CronTaskRecord {
  const createdAt = nowIso();
  const manualPath = path.join(
    agentDir,
    "docs",
    "rin",
    "docs",
    "self-improve-distillation.md",
  );
  const libraryPath = path.join(agentDir, "self_improve");
  const prompt = `Follow the self-improve distillation contract in ${manualPath}. Review ${libraryPath}: prompt baselines, reusable skills, memory-index pointers, and short-term continuity records. Also review the previous 24 hours of Rin activity from available evidence surfaces such as scheduled task records, maintenance history, recent sessions, chat message records, and runtime state; use that retrospective to find proven additions, corrections, moves, pruning, or removals that affect future guidance. Maintain the clean target state of future guidance: apply the manual's evidence, trigger, target behavior, and owning surface checks; delete or rewrite wrong guidance before considering new guidance; reject patch-layer fixes. Merge, move, prune stale or misplaced guidance, and add or rewrite guidance only for proven behavior changes that improve future behavior, routing, decisions, execution, recall, or remove guidance that would cause future mistakes. Report changed artifacts, cleanup work, routed candidates, or one concise unchanged reason.`;
  const task: CronTaskRecord = {
    id: "builtin_self_improve_sleep_consolidation_daily",
    builtIn: true,
    createdAt,
    updatedAt: createdAt,
    name: "Consolidate self-improve guidance",
    enabled: true,
    thinkingLevel: "medium",
    trigger: {
      expression: "43 3 * * *",
      timezone: "local",
    },
    session: { mode: "none" },
    target: { kind: "agent_prompt", prompt },
    disabledRinCapabilities: ["self_improve"],
    deliverFinal: true,
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
  const triggerChanged =
    JSON.stringify(existing.trigger || {}) !==
    JSON.stringify(builtin.trigger || {});
  const merged: CronTaskRecord = {
    ...builtin,
    createdAt: safeString(existing.createdAt).trim() || builtin.createdAt,
    updatedAt: safeString(existing.updatedAt).trim() || builtin.updatedAt,
    lastStartedAt: existing.lastStartedAt,
    lastFinishedAt: existing.lastFinishedAt,
    lastResultText: existing.lastResultText,
    lastError: existing.lastError ? safeString(existing.lastError) : undefined,
    runCount: Number(existing.runCount || 0),
    condition: builtin.condition,
    nextRunAt:
      !triggerChanged && safeString(existing.nextRunAt).trim()
        ? safeString(existing.nextRunAt).trim()
        : computeNextRunAt(builtin, Date.now()),
    running: false,
  };
  return merged;
}

function assertMutableTask(task: CronTaskRecord | undefined) {
  if (!task) return;
  if (task.builtIn) throw new Error(`cron_builtin_task_protected:${task.id}`);
}

function readCronTaskRows(file: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as CronTaskRecord[]) : undefined;
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    return undefined;
  }
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
    },
  ) {}

  start() {
    if (!this.load({ persist: true })) {
      this.installBuiltInTasks();
      this.save();
    }
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
    const frontend = normalizeTaskFrontend(input.frontend, existing);

    const normalizedTrigger = normalizeTaskTrigger(
      input.trigger ?? existing?.trigger,
    );
    const rawSession = input.session ?? existing?.session;
    const { normalizedSession } = normalizeTaskSession(
      rawSession?.mode === "session_instruction" &&
        !(rawSession as any).sessionFile
        ? { ...rawSession, sessionFile: defaults.sessionFile }
        : rawSession,
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
    const disabledRinCapabilities = normalizeDisabledRinCapabilities(
      input.disabledRinCapabilities,
      existing,
    );
    const normalizedTarget = normalizeTaskTarget(
      input.target ?? existing?.target,
    );
    if (session.mode === "session_instruction") {
      if (frontend)
        throw new Error("cron_session_instruction_frontend_forbidden");
      if (normalizedTarget.kind !== "agent_prompt") {
        throw new Error("cron_session_instruction_requires_agent_prompt");
      }
    }
    const { dedicatedSessionFile, dedicatedSessionPersistent } =
      resolveDedicatedSessionBinding({
        agentDir: this.options.agentDir,
        taskId: id,
        session,
      });
    const termination = normalizeTaskTermination(input.termination, existing);
    const condition = normalizeTaskCondition(input.condition, existing);

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
        frontend: normalizeTaskFrontend(defaults.frontend, undefined),
      },
      name,
      enabled,
      completedAt: existing?.completedAt,
      completionReason: existing?.completionReason,
      pausedAt: existing?.pausedAt,
      frontend,
      deliverFinal:
        input.deliverFinal !== undefined
          ? Boolean(input.deliverFinal)
          : (existing?.deliverFinal ?? true),
      model,
      thinkingLevel,
      disabledRinCapabilities,
      trigger: normalizedTrigger,
      termination,
      condition,
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

  rescheduleOneTimeTask(taskId: string, runAt: string) {
    const task = this.tasks.get(taskId);
    assertMutableTask(task);
    if (!task) throw new Error(`cron_task_not_found:${taskId}`);
    const nextRunAt =
      normalizeIso(runAt, "runAt") ||
      failCronTaskValidation("cron_runAt_required");
    const updatedTask: CronTaskRecord = {
      ...task,
      updatedAt: nowIso(),
      enabled: true,
      completedAt: undefined,
      completionReason: undefined,
      pausedAt: undefined,
      trigger: task.trigger.expression ? task.trigger : { runAt: nextRunAt },
      nextRunAt,
    };
    this.tasks.set(task.id, updatedTask);
    this.save();
    return this.publicTask(updatedTask);
  }

  wakeTaskNow(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`cron_task_not_found:${taskId}`);
    if (task.completedAt) throw new Error(`cron_task_completed:${taskId}`);
    task.enabled = true;
    delete task.pausedAt;
    task.nextRunAt = nowIso();
    task.updatedAt = nowIso();
    this.save();
    return this.publicTask(task);
  }

  runTaskNow(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`cron_task_not_found:${taskId}`);
    if (task.completedAt) throw new Error(`cron_task_completed:${taskId}`);
    if (this.activeExecutions.has(taskId)) {
      throw new Error(`cron_task_already_running:${taskId}`);
    }
    if (!this.evaluateCondition(task)) {
      this.rescheduleSkippedTask(task, "condition_false");
      return this.publicTask(task);
    }

    this.activeExecutions.set(task.id, { startedAt: Date.now() });
    task.lastStartedAt = nowIso();
    task.runCount += 1;
    task.lastError = undefined;
    task.updatedAt = nowIso();
    if (task.trigger.expression) {
      task.nextRunAt = nextCronAt(task.trigger.expression, Date.now());
    } else {
      task.nextRunAt = undefined;
    }
    this.save();
    void this.executeTask(task).catch(() => {});
    return this.publicTask(task);
  }

  private load(
    options: { persist?: boolean; terminateRemovedActiveTasks?: boolean } = {},
  ) {
    const file = cronTasksPath(this.options.agentDir);
    const rows = readCronTaskRows(file);
    if (!rows) return false;

    const loadedTasks = new Map<string, CronTaskRecord>();
    try {
      for (const row of rows) {
        if (!row || typeof row !== "object" || !row.id) continue;
        row.running = false;
        row.lastError = row.lastError ? safeString(row.lastError) : undefined;
        row.thinkingLevel = normalizeThinkingLevel(row.thinkingLevel);
        row.model = normalizeModelOverride(row.model);
        row.deliverFinal = row.deliverFinal !== false;
        const legacyChatKey = safeString((row as any).chatKey).trim();
        row.frontend = normalizeTaskFrontend(
          row.frontend ||
            (legacyChatKey ? { kind: "chat", key: legacyChatKey } : undefined),
          undefined,
        );
        delete (row as any).chatKey;
        const normalizedMode = normalizeScheduledTaskSessionMode(
          (row.session as any)?.mode,
        );
        row.session =
          normalizedMode === "session_instruction"
            ? {
                mode: normalizedMode,
                sessionFile: requireNonEmptyString(
                  (row.session as any)?.sessionFile,
                  "cron_session_file_required",
                ),
              }
            : { mode: normalizedMode || "none" };
        row.trigger = normalizeTaskTrigger(row.trigger);
        row.condition = normalizeTaskCondition(row.condition, undefined);
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
        loadedTasks.set(String(row.id), row);
      }
    } catch {
      return false;
    }

    const previousTasks = this.tasks;
    this.tasks = loadedTasks;
    this.installBuiltInTasks();
    if (options.terminateRemovedActiveTasks) {
      for (const [taskId, previousTask] of previousTasks) {
        if (!this.activeExecutions.has(taskId)) continue;
        const currentTask = this.tasks.get(taskId);
        if (!currentTask || currentTask.completedAt || !currentTask.enabled) {
          this.terminateTaskSession(previousTask);
        }
      }
    }

    if (options.persist !== false) this.save();
    return true;
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
      frontend,
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
      hasFrontendBinding: Boolean(frontend),
      frontendKind: frontend?.kind,
      session: { mode: snapshot.session.mode },
      target: { kind: target.kind },
    });
  }

  reloadTasks() {
    if (!this.load({ persist: true, terminateRemovedActiveTasks: true })) {
      throw new Error("cron_tasks_file_invalid");
    }
    return this.getStatusSnapshot();
  }

  private save() {
    writeJsonAtomic(
      cronTasksPath(this.options.agentDir),
      Array.from(this.tasks.values()).map((task) => this.persistedTask(task)),
    );
  }

  private mergeFinishedExecutionTask(task: CronTaskRecord) {
    const current = this.tasks.get(task.id);
    if (!current || current === task) return current;

    const currentNextRunAt = safeString(current.nextRunAt).trim();
    const currentStopped = current.completedAt || !current.enabled;
    current.lastStartedAt = task.lastStartedAt;
    current.lastFinishedAt = task.lastFinishedAt;
    current.lastResultText = task.lastResultText;
    current.lastError = task.lastError;
    current.runCount = Math.max(
      Number(current.runCount || 0),
      Number(task.runCount || 0),
    );
    current.updatedAt = task.updatedAt;

    if (task.dedicatedSessionFile) {
      current.dedicatedSessionFile = task.dedicatedSessionFile;
    }
    if (task.dedicatedSessionPersistent !== undefined) {
      current.dedicatedSessionPersistent = task.dedicatedSessionPersistent;
    }

    if (!currentStopped && !currentNextRunAt) {
      current.completedAt = task.completedAt;
      current.completionReason = task.completionReason;
      current.enabled = task.enabled;
      current.nextRunAt = task.nextRunAt;
    }

    return current;
  }

  private installBuiltInTasks() {
    const builtins = [
      createBuiltInMemoryIndexRepairTask(this.options.agentDir),
      createBuiltInSelfImproveSleepConsolidationTask(this.options.agentDir),
    ];
    for (const builtin of builtins) {
      const existing = this.tasks.get(builtin.id);
      this.tasks.set(builtin.id, mergeBuiltInTaskState(existing, builtin));
    }
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
        this.runTaskNow(task.id);
      }
    } finally {
      this.dispatching = false;
    }
  }

  private terminateTaskSession(task: CronTaskRecord | undefined) {
    if (!task || task.id.startsWith("builtin_self_improve_")) return;
    const controllerKey =
      task.frontend && task.frontend.kind !== "chat"
        ? task.frontend.key
        : task.id;
    void this.options.chat?.terminateTurn?.({ controllerKey }).catch(() => {});
  }

  private evaluateCondition(task: CronTaskRecord) {
    if (!task.condition) return true;
    const result = evaluateCronTaskCondition(task.condition, task);
    const now = nowIso();
    task.condition.lastEvaluatedAt = now;
    task.condition.lastResult = result.passed;
    task.condition.lastOutput = result.output;
    task.updatedAt = now;
    return result.passed;
  }

  private rescheduleSkippedTask(task: CronTaskRecord, reason: string) {
    const now = nowIso();
    task.updatedAt = now;
    task.lastFinishedAt = now;
    task.lastResultText = reason;
    const referenceTs = Date.now();
    if (task.trigger.expression) {
      task.nextRunAt = nextCronAt(task.trigger.expression, referenceTs);
    } else {
      task.nextRunAt = undefined;
      task.completedAt = now;
      task.completionReason = reason;
      task.enabled = false;
    }
    this.save();
  }

  private async executeTask(task: CronTaskRecord) {
    const scheduledNextRunAt = safeString(task.nextRunAt).trim() || undefined;
    try {
      await executeCronTask(task, this.options);
      if (
        !task.completedAt &&
        (safeString(task.nextRunAt).trim() || undefined) === scheduledNextRunAt
      ) {
        task.nextRunAt = computeNextRunAt(task, Date.now());
      }
    } finally {
      const currentTask = this.mergeFinishedExecutionTask(task);
      this.activeExecutions.delete(task.id);
      if (currentTask?.completedAt) this.terminateTaskSession(currentTask);
      this.save();
    }
  }
}
