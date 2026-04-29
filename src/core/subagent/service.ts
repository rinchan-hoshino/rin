import fs from "node:fs";
import os from "node:os";
import { normalizeStringList, safeString } from "../text-utils.js";

const HOME_DIR = os.homedir();

import type {
  AgentMessage as Message,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";

import { BUILTIN_MODULE_ORDER } from "../builtins/registry.js";
import { forkSessionManagerCompat } from "../session/fork.js";
import {
  getManagedSessionDir,
  MANAGED_SUBAGENT_SESSION_LEAF,
} from "../session/managed-paths.js";
import { loadRinCodingAgent } from "../rin-lib/loader.js";
import {
  createConfiguredAgentSession,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import { readUsageMetrics } from "../usage-metrics.js";
import {
  formatSubagentSessionModeInvalidError,
  formatSubagentSessionFileNotFoundError,
  formatSubagentSessionFileRequiredError,
  normalizeSubagentSessionConfig,
  resolveSubagentSessionFile,
  toSubagentSessionFile,
  type NormalizedSubagentSessionConfig,
} from "./session-utils.js";
import {
  buildModelLookup,
  getProviderSummaries,
  normalizeModelRef,
} from "./models.js";
import { getFinalOutput } from "./format-utils.js";
import type {
  RunSubagentParams,
  SubagentBackendInfo,
  SubagentSessionConfig,
  SubagentTask,
  TaskResult,
} from "./types.js";

let sessionCreationQueue: Promise<unknown> = Promise.resolve();

function withSessionCreationLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = sessionCreationQueue.then(fn, fn);
  sessionCreationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function normalizeDisabledExtensions(values: unknown): string[] {
  return Array.isArray(values)
    ? normalizeStringList(values, { lowercase: true })
    : [];
}

export function resolveSubagentDisabledBuiltinModules(
  disabledExtensions: string[] = [],
): string[] {
  const blocked = new Set(normalizeDisabledExtensions(disabledExtensions));
  blocked.add("subagent");
  return BUILTIN_MODULE_ORDER.filter((name) => blocked.has(name));
}

type NormalizedSubagentTask = Omit<
  SubagentTask,
  "session" | "disabledExtensions"
> & {
  session: NormalizedSubagentSessionConfig;
  disabledExtensions: string[];
};

function isPersistedMode(
  session: Pick<SubagentSessionConfig, "mode" | "keep">,
): boolean {
  const sessionConfig = normalizeSubagentSessionConfig(session);
  if (sessionConfig.mode === "memory") return false;
  if (sessionConfig.mode === "fork") return sessionConfig.keep !== false;
  return true;
}

async function loadSessionManagerModule() {
  const codingAgentModule = await loadRinCodingAgent();
  return { SessionManager: (codingAgentModule as any).SessionManager };
}

async function resolveSessionFilePath(
  sessionFile: string,
): Promise<{ path: string }> {
  const wanted = String(sessionFile || "").trim();
  const profile = resolveRuntimeProfile({ cwd: HOME_DIR });
  const resolved = resolveSubagentSessionFile(profile.agentDir, wanted);
  if (!resolved) {
    throw new Error("session_file_required");
  }
  try {
    if (fs.existsSync(resolved)) {
      return { path: resolved };
    }
  } catch {}
  throw new Error(formatSubagentSessionFileNotFoundError(wanted));
}

export { forkSessionManagerCompat } from "../session/fork.js";

async function createManagedSession(task: NormalizedSubagentTask) {
  const cwd = HOME_DIR;
  const sessionConfig = task.session;
  const profile = resolveRuntimeProfile({ cwd });
  const sessionDir = getManagedSessionDir(
    profile.agentDir,
    MANAGED_SUBAGENT_SESSION_LEAF,
  );
  const { SessionManager } = await loadSessionManagerModule();

  let sessionManager: any;
  switch (sessionConfig.mode) {
    case "memory":
      sessionManager = SessionManager.inMemory(cwd);
      break;
    case "persist":
      sessionManager = SessionManager.create(cwd, sessionDir);
      break;
    case "resume": {
      const source = await resolveSessionFilePath(
        sessionConfig.sessionFile || "",
      );
      sessionManager = SessionManager.open(source.path, sessionDir, undefined);
      break;
    }
    case "fork": {
      const source = await resolveSessionFilePath(
        sessionConfig.sessionFile || "",
      );
      sessionManager = forkSessionManagerCompat(
        SessionManager,
        source.path,
        cwd,
        sessionDir,
        {
          persist: sessionConfig.keep !== false,
        },
      );
      break;
    }
    default:
      throw new Error(
        formatSubagentSessionModeInvalidError(String(sessionConfig.mode || "")),
      );
  }

  const created = await withSessionCreationLock(async () => {
    return await createConfiguredAgentSession({
      cwd: sessionManager.getCwd?.() || cwd,
      agentDir: profile.agentDir,
      disabledBuiltinModules: resolveSubagentDisabledBuiltinModules(
        task.disabledExtensions,
      ),
      sessionManager,
      modelRef: task.model,
      thinkingLevel: task.thinkingLevel,
    });
  });

  if (sessionConfig.name) {
    created.session.setSessionName(sessionConfig.name);
  }

  return {
    ...created,
    sessionConfig,
  };
}

export function applySubagentTaskPreferences(task: {
  model?: string;
  thinkingLevel?: ThinkingLevel;
}) {
  return {
    modelRef: task.model,
    thinkingLevel: task.thinkingLevel,
  };
}

export async function getSubagentBackendInfo(
  ctx: any,
  currentThinkingLevel: ThinkingLevel,
): Promise<SubagentBackendInfo> {
  return {
    backend: "in-process-session",
    currentModel: ctx.model
      ? `${ctx.model.provider}/${ctx.model.id}`
      : undefined,
    currentThinkingLevel,
    providers: await getProviderSummaries(ctx),
  };
}

export function shouldApplyCurrentSubagentDefaults(
  session: SubagentSessionConfig | undefined,
): boolean {
  const sessionConfig = normalizeSubagentSessionConfig(session);
  return sessionConfig.mode !== "resume" && sessionConfig.mode !== "fork";
}

function normalizeSubagentTask(
  task: SubagentTask,
  defaults: {
    model?: string;
    thinkingLevel?: ThinkingLevel;
  } = {},
): NormalizedSubagentTask {
  return {
    prompt: String(task.prompt || ""),
    model: normalizeModelRef(task.model) || defaults.model,
    thinkingLevel: task.thinkingLevel || defaults.thinkingLevel,
    session: normalizeSubagentSessionConfig(task.session),
    disabledExtensions: normalizeDisabledExtensions(task.disabledExtensions),
  };
}

function buildTask(
  params: RunSubagentParams,
  ctx: any,
  currentThinkingLevel: ThinkingLevel,
): { ok: true; task: NormalizedSubagentTask } | { ok: false; error: string } {
  if (Array.isArray((params as any).tasks)) {
    return {
      ok: false,
      error: "run_subagent does not accept `tasks`.",
    };
  }

  if (!String(params.prompt || "").trim()) {
    return {
      ok: false,
      error: "run_subagent requires a non-empty `prompt`.",
    };
  }

  const useCurrentDefaults = shouldApplyCurrentSubagentDefaults(params.session);
  return {
    ok: true,
    task: normalizeSubagentTask(
      {
        prompt: String(params.prompt || ""),
        model: params.model,
        thinkingLevel: params.thinkingLevel,
        session: params.session,
        disabledExtensions: params.disabledExtensions,
      },
      useCurrentDefaults
        ? {
            model: ctx.model
              ? `${ctx.model.provider}/${ctx.model.id}`
              : undefined,
            thinkingLevel: currentThinkingLevel,
          }
        : {},
    ),
  };
}

function validateTask(
  task: NormalizedSubagentTask,
  details: SubagentBackendInfo,
): string | undefined {
  const availableModels = buildModelLookup(details.providers);
  if (!String(task.prompt || "").trim()) {
    return "Every subagent task needs a non-empty prompt.";
  }
  if (task.model && !availableModels.has(task.model)) {
    return `Unknown or unavailable model: ${task.model}`;
  }
  const sessionConfig = task.session;
  if (sessionConfig.invalidMode) {
    return formatSubagentSessionModeInvalidError(sessionConfig.invalidMode);
  }
  if (
    (sessionConfig.mode === "resume" || sessionConfig.mode === "fork") &&
    !sessionConfig.sessionFile
  ) {
    return formatSubagentSessionFileRequiredError(sessionConfig.mode);
  }
  if (
    (sessionConfig.mode === "memory" || sessionConfig.mode === "persist") &&
    sessionConfig.sessionFile
  ) {
    return "session.sessionFile is only valid with session.mode `resume` or `fork`.";
  }
  if (
    typeof sessionConfig.keep === "boolean" &&
    sessionConfig.mode !== "fork"
  ) {
    return "session.keep is only valid with session.mode `fork`. Use session.mode `persist` to create a saved worker session.";
  }
  return undefined;
}

function createEmptyUsageStats(): TaskResult["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function getSessionMessages(session: any): Message[] {
  return Array.isArray(session?.messages)
    ? (session.messages as Message[])
    : Array.isArray(session?.agent?.state?.messages)
      ? (session.agent.state.messages as Message[])
      : [];
}

export function collectTaskResultState(
  messages: Message[],
): Pick<
  TaskResult,
  "output" | "stopReason" | "errorMessage" | "model" | "usage"
> {
  const usage = createEmptyUsageStats();
  let stopReason: TaskResult["stopReason"];
  let errorMessage: TaskResult["errorMessage"];
  let model: TaskResult["model"];

  for (const rawMessage of messages) {
    const message = rawMessage as any;
    if (message?.role !== "assistant") continue;
    stopReason = message.stopReason;
    errorMessage = message.errorMessage;
    if (message.model) {
      model = `${message.provider}/${message.model}`;
    }
    const currentUsage = message.usage;
    if (!currentUsage) continue;
    const usageMetrics = readUsageMetrics(currentUsage);
    usage.turns += 1;
    usage.input += usageMetrics.input;
    usage.output += usageMetrics.output;
    usage.cacheRead += usageMetrics.cacheRead;
    usage.cacheWrite += usageMetrics.cacheWrite;
    usage.cost += usageMetrics.costTotal;
    usage.contextTokens = usageMetrics.totalTokens || usage.contextTokens;
  }

  return {
    output: getFinalOutput(messages),
    stopReason,
    errorMessage,
    model,
    usage,
  };
}

function syncSessionMetadata(session: any, result: TaskResult): void {
  const manager = session?.sessionManager;
  const profile = resolveRuntimeProfile({ cwd: HOME_DIR });
  result.sessionPersisted = Boolean(
    manager?.isPersisted?.() && manager?.getSessionFile?.(),
  );
  result.sessionId =
    safeString(manager?.getSessionId?.() || "").trim() || undefined;
  result.sessionFile = toSubagentSessionFile(
    profile.agentDir,
    manager?.getSessionFile?.(),
  );
  result.sessionName =
    safeString(manager?.getSessionName?.() || "").trim() || undefined;
}

function syncResultFromMessages(messages: Message[], result: TaskResult): void {
  const state = collectTaskResultState(messages);
  result.output = state.output;
  result.stopReason = state.stopReason;
  result.errorMessage = state.errorMessage;
  result.model = state.model;
  result.usage = state.usage;
}

function syncResultFromSession(
  session: any,
  result: TaskResult,
  sinceMessageIndex = 0,
): void {
  const sessionMessages = getSessionMessages(session).slice(sinceMessageIndex);
  const resultMessages =
    sessionMessages.length > 0 ? sessionMessages : [...result.messages];

  result.messages.length = 0;
  result.messages.push(...resultMessages);
  syncSessionMetadata(session, result);
  syncResultFromMessages(result.messages, result);
}

function createTaskResult(
  task: NormalizedSubagentTask,
  index: number,
  messages: Message[] = [],
): TaskResult {
  const sessionConfig = task.session;
  return {
    index,
    prompt: task.prompt,
    requestedModel: task.model,
    requestedThinkingLevel: task.thinkingLevel,
    status: "pending",
    exitCode: 0,
    output: "",
    usage: createEmptyUsageStats(),
    messages,
    sessionMode: sessionConfig.mode,
    sessionPersisted: isPersistedMode(sessionConfig),
  };
}

function snapshotTaskResult(result: TaskResult): TaskResult {
  return {
    ...result,
    usage: { ...result.usage },
    messages: [...result.messages],
  };
}

function emitTaskProgress(
  result: TaskResult,
  onProgress?: (result: TaskResult) => void,
): void {
  onProgress?.(snapshotTaskResult(result));
}

function setTaskResultError(
  result: TaskResult,
  error: unknown,
  session?: any,
): void {
  result.exitCode = 1;
  result.status = "error";
  result.errorMessage = String(
    (error as any)?.message || error || "subagent_failed",
  );
  if (session) {
    syncSessionMetadata(session, result);
  }
}

export async function executeSubagentRun(options: {
  params: RunSubagentParams;
  ctx: any;
  currentThinkingLevel: ThinkingLevel;
  signal?: AbortSignal;
  onProgress?: (results: TaskResult[], details: SubagentBackendInfo) => void;
}): Promise<
  | ({ ok: true; results: TaskResult[] } & SubagentBackendInfo)
  | ({ ok: false; error: string; results?: TaskResult[] } & SubagentBackendInfo)
> {
  const details = await getSubagentBackendInfo(
    options.ctx,
    options.currentThinkingLevel,
  );
  const built = buildTask(
    options.params,
    options.ctx,
    options.currentThinkingLevel,
  );
  if (built.ok === false) {
    return { ok: false, error: built.error, ...details };
  }

  const validationError = validateTask(built.task, details);
  if (validationError) {
    return { ok: false, error: validationError, ...details };
  }

  const pending = createTaskResult(built.task, 1);
  options.onProgress?.([snapshotTaskResult(pending)], details);

  const result = await runSubagentTask(
    built.task,
    1,
    options.signal,
    (partial) => {
      options.onProgress?.([snapshotTaskResult(partial)], details);
    },
  );

  return { ok: true, results: [result], ...details };
}

export async function runSubagentTask(
  task: NormalizedSubagentTask,
  index: number,
  signal?: AbortSignal,
  onProgress?: (result: TaskResult) => void,
): Promise<TaskResult> {
  const messages: Message[] = [];
  const result = createTaskResult(task, index, messages);

  let session: any;
  let runtime: any;
  let initialMessageCount = 0;
  try {
    const created = await createManagedSession(task);
    session = created.session;
    runtime = created.runtime;
    initialMessageCount = getSessionMessages(session).length;
    syncSessionMetadata(session, result);
  } catch (error: any) {
    setTaskResultError(result, error);
    emitTaskProgress(result, onProgress);
    return result;
  }

  result.status = "running";
  emitTaskProgress(result, onProgress);
  const unsubscribe = session.subscribe((event: any) => {
    if (event?.type !== "message_end" || !event.message) return;
    const message = event.message as Message;
    messages.push(message);
    if (message.role !== "assistant") return;
    syncSessionMetadata(session, result);
    syncResultFromMessages(messages, result);
    emitTaskProgress(result, onProgress);
  });

  let abortListener: (() => void) | undefined;

  try {
    if (signal) {
      const onAbort = () => {
        void session.abort().catch(() => {});
      };
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        abortListener = () => signal.removeEventListener("abort", onAbort);
      }
    }
    await session.prompt(task.prompt, {
      expandPromptTemplates: false,
      source: "builtin:subagent",
    });
    await session.agent.waitForIdle();
    syncResultFromSession(session, result, initialMessageCount);
    const failed =
      result.stopReason === "error" || result.stopReason === "aborted";
    result.exitCode = failed ? 1 : 0;
    result.status = failed ? "error" : "done";
    emitTaskProgress(result, onProgress);
    return result;
  } catch (error: any) {
    setTaskResultError(result, error, session);
    emitTaskProgress(result, onProgress);
    return result;
  } finally {
    abortListener?.();
    unsubscribe();
    try {
      await session?.abort?.();
    } catch {}
    try {
      await runtime?.dispose?.();
    } catch {}
  }
}
