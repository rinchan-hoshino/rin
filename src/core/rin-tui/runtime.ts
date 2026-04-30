import type {
  AgentEvent,
  AgentMessage,
  ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import { buildSessionContext } from "@mariozechner/pi-coding-agent";

import {
  getRuntimeSessionDir,
  resolveRuntimeProfile,
} from "../rin-lib/runtime.js";
import { isSessionScopedCommand } from "../rin-lib/rpc.js";
import type { RpcFrontendClient } from "./frontend-surface.js";
import { handleRpcSessionEvent } from "./events.js";
import type { TuiResourceOptions } from "./cli-options.js";
import { loadRpcLocalExtensions } from "./extensions.js";
import {
  setRpcAutoCompaction,
  cycleRpcModel,
  cycleRpcThinkingLevel,
  getPersistentSettingsManager,
  persistRpcSettingsMutation,
  setRpcFollowUpMode,
  setRpcModel,
  setRpcSteeringMode,
  setRpcThinkingLevel,
} from "./model-settings.js";
type PendingRpcOperation = {
  mode: "prompt" | "steer" | "follow_up";
  message: string;
  images?: any[];
  streamingBehavior?: "steer" | "followUp";
  source?: string;
  requestTag?: string;
};
import { createModelRegistry } from "./rpc-model-registry.js";
import {
  computeAvailableThinkingLevels,
  extractText,
  getLastAssistantText,
} from "./session-helpers.js";
import { computeSessionStats, getContextUsage } from "./stats.js";
import {
  applyRpcSessionState,
  applyRpcSessionTree,
  getSessionBranch,
} from "./state-utils.js";
import { normalizeBoundSessionList } from "../session/listing.js";

type RpcExtensionBindings = {
  uiContext?: any;
  commandContextActions?: any;
  shutdownHandler?: () => void;
  onError?: (error: any) => void;
};

type RpcExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

function extensionUiRequestId(payload: any) {
  return String(payload?.id || "").trim();
}

function cancelledExtensionUiResponse(
  payload: any,
): RpcExtensionUiResponse | undefined {
  const id = extensionUiRequestId(payload);
  return id
    ? { type: "extension_ui_response", id, cancelled: true }
    : undefined;
}

type RpcResourceSnapshot = {
  skills: { skills: any[]; diagnostics: any[] };
  prompts: { prompts: any[]; diagnostics: any[] };
  themes: { themes: any[]; diagnostics: any[] };
  extensions: { extensions: any[]; errors: any[] };
};

function emptyRpcResourceSnapshot(): RpcResourceSnapshot {
  return {
    skills: { skills: [], diagnostics: [] },
    prompts: { prompts: [], diagnostics: [] },
    themes: { themes: [], diagnostics: [] },
    extensions: { extensions: [], errors: [] },
  };
}

function normalizeResourceSection(value: any, itemKey: string) {
  return {
    [itemKey]: Array.isArray(value?.[itemKey]) ? value[itemKey] : [],
    diagnostics: Array.isArray(value?.diagnostics) ? value.diagnostics : [],
  };
}

function normalizeRpcResourceSnapshot(value: any): RpcResourceSnapshot {
  return {
    skills: normalizeResourceSection(value?.skills, "skills") as {
      skills: any[];
      diagnostics: any[];
    },
    prompts: normalizeResourceSection(value?.prompts, "prompts") as {
      prompts: any[];
      diagnostics: any[];
    },
    themes: normalizeResourceSection(value?.themes, "themes") as {
      themes: any[];
      diagnostics: any[];
    },
    extensions: {
      extensions: Array.isArray(value?.extensions?.extensions)
        ? value.extensions.extensions
        : [],
      errors: Array.isArray(value?.extensions?.errors)
        ? value.extensions.errors
        : [],
    },
  };
}

function normalizeQueuedMessages(value: any) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = String(item ?? "");
    return text ? [text] : [];
  });
}

function serializeRpcResourceOptions(options: TuiResourceOptions) {
  return {
    additionalExtensionPaths: [...(options.additionalExtensionPaths || [])],
    noExtensions: options.noExtensions,
    extensionFlagValues: Array.from(
      options.extensionFlagValues?.entries?.() || [],
    ),
    additionalSkillPaths: [...(options.additionalSkillPaths || [])],
    noSkills: options.noSkills,
    additionalPromptTemplatePaths: [
      ...(options.additionalPromptTemplatePaths || []),
    ],
    noPromptTemplates: options.noPromptTemplates,
    additionalThemePaths: [...(options.additionalThemePaths || [])],
    noThemes: options.noThemes,
    noContextFiles: options.noContextFiles,
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: [...(options.appendSystemPrompt || [])],
  };
}

function createRpcResourceLoader(getSnapshot: () => RpcResourceSnapshot) {
  return {
    getThemes: () => getSnapshot().themes,
    getSkills: () => getSnapshot().skills,
    getPrompts: () => getSnapshot().prompts,
    getExtensions: () => getSnapshot().extensions,
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getPathMetadata: () => new Map(),
  };
}

const REFRESH_MESSAGES = { messages: true } as const;
const REFRESH_MODELS = { models: true } as const;
const REFRESH_SESSION = { session: true } as const;
const REFRESH_MESSAGES_AND_SESSION = { messages: true, session: true } as const;
const REFRESH_ALL = { messages: true, models: true, session: true } as const;

async function completeRpcRecovery(target: any) {
  const canApplyLightweightState =
    typeof target.call === "function" &&
    typeof target.applyState === "function";
  if (canApplyLightweightState) {
    target.applyState(await target.call("get_state"));
  } else {
    await target.refreshState(REFRESH_MESSAGES_AND_SESSION);
  }
  target.recoveryPending = false;
  if (!canApplyLightweightState) {
    target.emitSessionResynced();
  }
  target.emitFrontendStatus(true);
  const queued = [...target.queuedOfflineOps];
  target.queuedOfflineOps = [];
  for (const operation of queued) {
    await target.sendOrQueue(operation);
  }
  if (canApplyLightweightState && typeof target.refreshState === "function") {
    void target
      .refreshState(REFRESH_MESSAGES_AND_SESSION)
      .then(() => {
        target.emitSessionResynced();
        target.emitFrontendStatus(true);
      })
      .catch(() => {});
  }
}

class RemoteAgent {
  constructor(private client: RpcFrontendClient) {}

  abort() {
    void this.client.abort().catch(() => {});
  }

  waitForIdle(timeout = 60000) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error("rin_wait_for_idle_timeout"));
      }, timeout);
      const unsubscribe = this.client.subscribe((event) => {
        if (event.type !== "ui") return;
        if ((event.payload as any)?.type !== "agent_end") return;
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });
  }

  async setTransport(_transport: string) {}
}

type RefreshFlags = { messages?: boolean; models?: boolean; session?: boolean };

type RpcFrontendPhase =
  | "idle"
  | "starting"
  | "sending"
  | "compacting"
  | "working"
  | "connecting";

const RPC_FRONTEND_PHASE_LABELS: Record<
  Exclude<RpcFrontendPhase, "idle">,
  string
> = {
  connecting: "Connecting",
  starting: "Starting",
  sending: "Sending",
  compacting: "Compacting context",
  working: "Working",
};

function getRuntimeProfile() {
  return resolveRuntimeProfile();
}

function getRuntimeSessionDirForProfile(profile: {
  cwd: string;
  agentDir: string;
}) {
  return getRuntimeSessionDir(profile.cwd, profile.agentDir);
}

export class RpcInteractiveSession {
  public agent: RemoteAgent;
  public settingsManager: any;
  public modelRegistry: any;
  public resourceLoader: any;
  public sessionManager: any;

  public scopedModels: any[] = [];
  public promptTemplates: any[] = [];
  public extensionRunner: any = undefined;
  public activeToolsCache: string[] = [];
  public allToolsCache: any[] = [];
  public model: any = null;
  public thinkingLevel: ThinkingLevel = "medium";
  public steeringMode: "all" | "one-at-a-time" = "all";
  public followUpMode: "all" | "one-at-a-time" = "one-at-a-time";
  public systemPrompt = "";
  public isStreaming = false;
  public isCompacting = false;
  public isBashRunning = false;
  public retryAttempt = 0;
  public pendingMessageCount = 0;
  public autoCompactionEnabled = false;
  public messages: AgentMessage[] = [];
  public state: any = {
    messages: this.messages,
    model: null,
    thinkingLevel: this.thinkingLevel,
  };

  private sessionId = "";
  private sessionFile?: string;
  private sessionName?: string;
  private leafId: string | null = null;
  private entries: any[] = [];
  private tree: any[] = [];
  private entryById = new Map<string, any>();
  private labelsById = new Map<string, string | undefined>();
  private lastSessionStats: any = undefined;
  private steeringMessages: string[] = [];
  private followUpMessages: string[] = [];
  private listeners = new Set<(event: AgentEvent) => void>();
  private unsubscribeClient?: () => void;
  private extensionBindings: RpcExtensionBindings = {};
  public extensionOptions: TuiResourceOptions;
  private additionalExtensionPaths: string[];
  private reconnecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private queuedOfflineOps: PendingRpcOperation[] = [];
  private activeTurn: PendingRpcOperation | null = null;
  private rpcConnected = false;
  private remoteTurnRunning = false;
  private recoveringTurnPending = false;
  private disposed = false;
  private pendingRefreshFlags: RefreshFlags = {};
  private refreshLoopPromise: Promise<void> | null = null;
  private restorePromise: Promise<void> | null = null;
  private waitForDaemonPromise: Promise<void> | null = null;
  private waitForDaemonHintTimer: NodeJS.Timeout | null = null;
  private startupPending = true;
  private resourceSnapshot = emptyRpcResourceSnapshot();
  private sessionOperationPending = false;
  private recoveryPending = false;
  private clearQueuePromise: Promise<void> | null = null;
  private lastFrontendPhase: RpcFrontendPhase | null = null;
  private nextRequestTagId = 0;

  constructor(
    public client: RpcFrontendClient,
    extensionOptions: string[] | Partial<TuiResourceOptions> = [],
  ) {
    const normalizedExtensionOptions = Array.isArray(extensionOptions)
      ? { additionalExtensionPaths: extensionOptions }
      : extensionOptions;
    this.extensionOptions = {
      additionalExtensionPaths: [
        ...(normalizedExtensionOptions.additionalExtensionPaths ?? []),
      ],
      additionalSkillPaths: [
        ...(normalizedExtensionOptions.additionalSkillPaths ?? []),
      ],
      additionalPromptTemplatePaths: [
        ...(normalizedExtensionOptions.additionalPromptTemplatePaths ?? []),
      ],
      additionalThemePaths: [
        ...(normalizedExtensionOptions.additionalThemePaths ?? []),
      ],
      noExtensions: normalizedExtensionOptions.noExtensions,
      extensionFlagValues: normalizedExtensionOptions.extensionFlagValues,
      noSkills: normalizedExtensionOptions.noSkills,
      noPromptTemplates: normalizedExtensionOptions.noPromptTemplates,
      noThemes: normalizedExtensionOptions.noThemes,
      noContextFiles: normalizedExtensionOptions.noContextFiles,
      systemPrompt: normalizedExtensionOptions.systemPrompt,
      appendSystemPrompt: normalizedExtensionOptions.appendSystemPrompt,
    };
    this.additionalExtensionPaths = [
      ...this.extensionOptions.additionalExtensionPaths,
    ];
    const proto = Object.getPrototypeOf(this);
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (!descriptor || typeof descriptor.value !== "function") continue;
      (this as any)[name] = descriptor.value.bind(this);
    }
    this.agent = new RemoteAgent(client);
    this.settingsManager = undefined;
    this.modelRegistry = createModelRegistry(client);
    this.resourceLoader = createRpcResourceLoader(() => this.resourceSnapshot);
    this.sessionManager = {
      getSessionFile: () => this.sessionFile,
      getSessionId: () => this.sessionId,
      getHeader: () => null,
      getEntry: (id: string) => this.entryById.get(id),
      getLabel: (id: string) => this.labelsById.get(id),
      getBranch: (fromId?: string) => this.getBranch(fromId),
      buildSessionContext: () =>
        buildSessionContext(this.entries, this.leafId, this.entryById as any),
      getEntries: () => [...this.entries],
      getSessionName: () => this.sessionName,
      getTree: () => [...this.tree],
      getLeafId: () => this.leafId,
      appendLabelChange: (entryId: string, label: string | undefined) =>
        void this.setEntryLabel(entryId, label).catch(() => {}),
      getCwd: () => getRuntimeProfile().cwd,
      getSessionDir: () => getRuntimeSessionDirForProfile(getRuntimeProfile()),
      appendSessionInfo: (name: string) =>
        void this.setSessionName(name).catch(() => {}),
    };
  }

  async prepareForInteractiveStartup() {
    this.settingsManager ??= await getPersistentSettingsManager();
    this.autoCompactionEnabled = Boolean(
      this.settingsManager.getCompactionEnabled?.(),
    );
  }

  async connect() {
    this.disposed = false;
    this.startupPending = true;
    this.emitFrontendStatus(true);
    await this.prepareForInteractiveStartup();
    this.unsubscribeClient?.();
    this.unsubscribeClient = this.client.subscribe((event) => {
      if (event.type === "ui" && event.name === "connection_lost") {
        this.handleConnectionLost();
        return;
      }
      if (event.type !== "ui") return;
      const payload: any = event.payload;
      if (!payload || payload.type === "response") return;
      if (payload.type === "oauth_login_event") {
        this.modelRegistry.authStorage.handleEvent(payload);
        return;
      }
      this.handleRpcEvent(payload);
    });
    try {
      await this.client.connect();
      this.setRpcConnected(true);
      await this.refreshState(REFRESH_MESSAGES_AND_SESSION).catch(() => {});
      await this.modelRegistry.sync().catch(() => {});
    } catch (error) {
      this.handleConnectionLost();
      throw error;
    } finally {
      this.startupPending = false;
      this.emitFrontendStatus(true);
    }
  }

  async disconnect() {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearWaitingDaemonState();
    this.unsubscribeClient?.();
    this.unsubscribeClient = undefined;
    this.recoveryPending = false;
    this.setRpcConnected(false);
    await this.client.disconnect();
  }

  subscribe(listener: (event: AgentEvent) => void) {
    this.listeners.add(listener);
    const current = this.getFrontendStatusEvent();
    if (current) {
      try {
        listener(current as AgentEvent);
      } catch {}
    }
    return () => this.listeners.delete(listener);
  }

  async prompt(
    message: string,
    options?: {
      streamingBehavior?: "steer" | "followUp";
      images?: any[];
      source?: string;
      requestTag?: string;
      expandPromptTemplates?: boolean;
    },
  ) {
    const expandPromptTemplates = options?.expandPromptTemplates ?? true;
    if (expandPromptTemplates && this.isFrontendExtensionCommand(message)) {
      await this.runCommand(message);
      return;
    }
    await this.sendOrQueue({
      mode: "prompt",
      message,
      images: options?.images,
      streamingBehavior: options?.streamingBehavior,
      source: options?.source,
      requestTag: this.ensureRequestTag(options?.requestTag),
    });
  }

  async resumeInterruptedTurn(options?: {
    source?: string;
    requestTag?: string;
  }) {
    await this.ensureRemoteSession();
    await this.call("resume_interrupted_turn", {
      source: options?.source,
      requestTag: this.ensureRequestTag(options?.requestTag),
    });
  }

  async steer(
    message: string,
    images?: any[],
    options?: { source?: string; requestTag?: string },
  ) {
    await this.sendOrQueue({
      mode: "steer",
      message,
      images,
      source: options?.source,
      requestTag: this.ensureRequestTag(options?.requestTag),
    });
  }

  async followUp(
    message: string,
    images?: any[],
    options?: { source?: string; requestTag?: string },
  ) {
    await this.sendOrQueue({
      mode: "follow_up",
      message,
      images,
      source: options?.source,
      requestTag: this.ensureRequestTag(options?.requestTag),
    });
  }

  clearQueue() {
    const queued = {
      steering: [...this.steeringMessages],
      followUp: [...this.followUpMessages],
    };
    this.steeringMessages = [];
    this.followUpMessages = [];
    this.syncPendingCount();
    this.emitQueueUpdate();
    if (
      this.client.isConnected() &&
      this.rpcConnected &&
      !this.recoveryPending
    ) {
      const clearQueuePromise = this.call("clear_queue")
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          if (this.clearQueuePromise === clearQueuePromise) {
            this.clearQueuePromise = null;
          }
        });
      this.clearQueuePromise = clearQueuePromise;
    }
    return queued;
  }

  getSteeringMessages() {
    return [...this.steeringMessages];
  }
  getFollowUpMessages() {
    return [...this.followUpMessages];
  }
  async abort() {
    this.activeTurn = null;
    this.remoteTurnRunning = false;
    this.isCompacting = false;
    this.isBashRunning = false;
    this.retryAttempt = 0;
    this.syncStreamingState();
    void this.client.abort().catch(() => {});
  }

  async newSession(options?: {
    parentSession?: string;
    managedSessionLeaf?: string;
  }) {
    this.setSessionOperationPending(true);
    try {
      const data = await this.call("new_session", {
        parentSession: options?.parentSession,
        managedSessionLeaf: options?.managedSessionLeaf,
        resourceOptions: serializeRpcResourceOptions(this.extensionOptions),
      });
      await this.refreshState(REFRESH_ALL);
      return !Boolean(data?.cancelled);
    } finally {
      this.setSessionOperationPending(false);
    }
  }

  async switchSession(sessionPath: string, _cwdOverride?: string) {
    this.setSessionOperationPending(true);
    try {
      const data = await this.call("switch_session", {
        sessionPath,
        resourceOptions: serializeRpcResourceOptions(this.extensionOptions),
      });
      await this.refreshState(REFRESH_ALL);
      return !Boolean(data?.cancelled);
    } finally {
      this.setSessionOperationPending(false);
    }
  }

  async renameSession(sessionPath: string, name: string) {
    await this.call("rename_session", { sessionPath, name });
    if (this.sessionFile === sessionPath)
      await this.refreshState(REFRESH_SESSION);
  }

  async listSessions(
    scope: "all" = "all",
    _onProgress?: (loaded: number, total: number) => void,
  ) {
    this.setSessionOperationPending(true);
    try {
      if (!this.client.isConnected()) {
        await this.waitForDaemonAvailable();
      }
      const data = await this.call("list_sessions", { scope });
      return normalizeBoundSessionList(data?.sessions);
    } finally {
      this.setSessionOperationPending(false);
    }
  }

  async setModel(model: any) {
    await setRpcModel(this as any, model, () =>
      this.refreshState(REFRESH_MODELS),
    );
  }

  persistSettingsMutation(mutate: (settings: any) => void | Promise<void>) {
    return persistRpcSettingsMutation(mutate);
  }

  setScopedModels(
    scopedModels: Array<{ model: any; thinkingLevel?: ThinkingLevel }>,
  ) {
    this.scopedModels = [...scopedModels];
  }

  async cycleModel(direction?: "forward" | "backward") {
    return await cycleRpcModel(this as any, direction, () =>
      this.refreshState(REFRESH_MODELS),
    );
  }

  setThinkingLevel(level: ThinkingLevel) {
    setRpcThinkingLevel(this as any, level);
  }

  cycleThinkingLevel(): ThinkingLevel | undefined {
    return cycleRpcThinkingLevel(this as any);
  }

  getAvailableThinkingLevels() {
    return computeAvailableThinkingLevels(this.model);
  }

  setSteeringMode(mode: "all" | "one-at-a-time") {
    setRpcSteeringMode(this as any, mode);
  }

  setFollowUpMode(mode: "all" | "one-at-a-time") {
    setRpcFollowUpMode(this as any, mode);
  }

  async compact(customInstructions?: string) {
    const data = await this.call("compact", { customInstructions });
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
    return data;
  }

  abortCompaction() {
    void this.client.abort().catch(() => {});
  }
  abortBranchSummary() {}

  setAutoCompactionEnabled(enabled: boolean) {
    setRpcAutoCompaction(this as any, enabled);
  }

  async executeBash(command: string) {
    this.isBashRunning = true;
    try {
      const data = await this.call("bash", { command });
      await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
      return data;
    } finally {
      this.isBashRunning = false;
    }
  }

  async ensureSessionReady() {
    this.startupPending = true;
    this.emitFrontendStatus(true);
    try {
      await this.ensureRemoteSession();
      await this.refreshResourceDiagnostics();
      return {
        sessionFile: this.sessionFile,
        sessionId: this.sessionId,
        sessionName: this.sessionName,
      };
    } finally {
      this.startupPending = false;
      this.emitFrontendStatus(true);
    }
  }

  async getActiveTools() {
    const data = await this.call("get_active_tools");
    this.activeToolsCache = Array.isArray(data?.tools) ? data.tools : [];
    return this.activeToolsCache;
  }

  async getAllTools() {
    const data = await this.call("get_all_tools");
    this.allToolsCache = Array.isArray(data?.tools) ? data.tools : [];
    return this.allToolsCache;
  }

  async setActiveToolsByName(toolNames: string[]) {
    const data = await this.call("set_active_tools", { toolNames });
    this.activeToolsCache = Array.isArray(data?.tools)
      ? data.tools
      : [...toolNames];
    await this.refreshState(REFRESH_SESSION).catch(() => {});
  }

  async refreshTools() {
    const data = await this.call("refresh_tools");
    this.allToolsCache = Array.isArray(data?.tools) ? data.tools : [];
    return this.allToolsCache;
  }

  async appendEntry(customType: string, data?: unknown) {
    await this.call("append_custom_entry", { customType, data });
    await this.refreshState(REFRESH_SESSION).catch(() => {});
  }

  async sendCustomMessage(message: any, options?: any) {
    await this.call("send_custom_message", { message, options });
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION).catch(() => {});
  }

  async sendUserMessage(content: any, options?: any) {
    await this.call("send_user_message", {
      content,
      options,
      requestTag: this.ensureRequestTag(options?.requestTag),
    });
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION).catch(() => {});
  }

  async runCommand(commandLine: string) {
    const trimmed = String(commandLine || "").trim();
    if (trimmed === "/abort") {
      await this.abort();
      return { handled: true, text: "Aborted current operation." };
    }
    if (trimmed === "/new") {
      const completed = await this.newSession();
      return {
        handled: true,
        text: completed
          ? "Started a new session."
          : "Session switch cancelled.",
      };
    }
    if (trimmed.startsWith("/resume ")) {
      const wanted = trimmed.slice("/resume ".length).trim();
      if (wanted) {
        const sessions = await this.listSessions("all");
        const match = sessions.find(
          (item: any) => String(item?.id || "") === wanted,
        );
        if (!match)
          return { handled: true, text: `Session not found: ${wanted}` };
        const completed = await this.switchSession(String(match.path || ""));
        return {
          handled: true,
          text: completed
            ? `Resumed session: ${String(match.id || "")}`
            : "Session switch cancelled.",
        };
      }
    }
    await this.ensureRemoteSession();
    const data = await this.call("run_command", { commandLine });
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
    return data;
  }

  async terminateSession() {
    if (!this.client.isConnected()) return;
    await this.call("terminate_session");
  }

  async detachSession() {
    await this.call("detach_session");
    await this.refreshState(REFRESH_ALL).catch(() => {});
  }

  recordBashResult(
    _command: string,
    _result: any,
    _options?: { excludeFromContext?: boolean },
  ) {}

  async abortBash() {
    await this.call("abort_bash");
    this.isBashRunning = false;
  }

  abortRetry() {
    void this.call("abort_retry").catch(() => {});
  }
  get isRetrying() {
    return this.retryAttempt > 0;
  }
  get autoRetryEnabled() {
    return false;
  }
  setAutoRetryEnabled(_enabled: boolean) {}

  setSessionName(name: string) {
    this.sessionName = name;
    return this.call("set_session_name", { name }).then(async () => {
      await this.refreshState(REFRESH_SESSION);
    });
  }

  async setEntryLabel(entryId: string, label: string | undefined) {
    await this.call("set_entry_label", { entryId, label });
    await this.refreshState(REFRESH_SESSION);
  }

  async fork(entryId: string) {
    const data = await this.call("fork", { entryId });
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
    return {
      cancelled: Boolean(data?.cancelled),
      selectedText: String(data?.text || ""),
    };
  }

  async navigateTree(
    targetId: string,
    options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ) {
    const data = await this.call("navigate_tree", {
      targetId,
      summarize: options?.summarize,
      customInstructions: options?.customInstructions,
      replaceInstructions: options?.replaceInstructions,
      label: options?.label,
    });
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
    return {
      cancelled: Boolean(data?.cancelled),
      aborted: Boolean(data?.aborted),
      editorText: typeof data?.editorText === "string" ? data.editorText : "",
      summaryEntry: data?.summaryEntry,
    };
  }

  getUserMessagesForForking() {
    return this.entries
      .filter(
        (entry: any) =>
          entry?.type === "message" && entry.message?.role === "user",
      )
      .map((entry: any) => ({
        entryId: String(entry.id),
        text: extractText(entry.message?.content),
      }))
      .filter((entry: any) => entry.text);
  }

  getSessionStats() {
    this.lastSessionStats = this.computeSessionStats();
    return this.lastSessionStats;
  }

  getContextUsage() {
    return getContextUsage(this.model, this.messages, this.getBranch());
  }

  async exportToHtml(outputPath?: string) {
    const data = await this.call("export_html", { outputPath });
    return String(data?.path || "");
  }

  async exportToJsonl(outputPath?: string) {
    const data = await this.call("export_jsonl", { outputPath });
    return String(data?.path || "");
  }

  async importFromJsonl(inputPath: string, _cwdOverride?: string) {
    this.setSessionOperationPending(true);
    try {
      const data = await this.call("import_jsonl", { inputPath });
      await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
      return !Boolean(data?.cancelled);
    } finally {
      this.setSessionOperationPending(false);
    }
  }

  getLastAssistantText() {
    return getLastAssistantText(this.messages);
  }

  getToolDefinition(toolName: string) {
    return this.extensionRunner?.getToolDefinition?.(toolName);
  }

  async reload() {
    await this.modelRegistry.sync();
    await this.refreshResourceDiagnostics().catch(() => {});
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
    if (this.extensionRunner) {
      await this.shutdownLocalExtensions({ reason: "reload" });
      await this.loadLocalExtensions(true);
    }
  }

  async shutdownLocalExtensions(event: Record<string, unknown>) {
    const runner = this.extensionRunner;
    if (!runner) return false;
    try {
      if (runner.hasHandlers?.("session_shutdown")) {
        await runner.emit({ ...event, type: "session_shutdown" });
      }
    } finally {
      runner.invalidate?.();
      if (this.extensionRunner === runner) this.extensionRunner = undefined;
    }
    return true;
  }

  async bindExtensions(bindings: RpcExtensionBindings = {}) {
    this.extensionBindings = {
      ...this.extensionBindings,
      ...bindings,
    };
    await this.loadLocalExtensions(false);
  }

  private async loadLocalExtensions(forceReload: boolean) {
    await loadRpcLocalExtensions(this as any, forceReload, getRuntimeProfile());
  }

  private handleRpcEvent(payload: any) {
    if (payload?.type === "extension_ui_request") {
      void this.handleExtensionUiRequest(payload).catch((error) => {
        this.extensionBindings.onError?.({
          extensionPath: "rpc:extension_ui_request",
          event: payload?.method || "extension_ui_request",
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    void handleRpcSessionEvent(
      this as any,
      payload,
      () => this.queueRefreshState(REFRESH_MESSAGES),
      () => this.queueRefreshState(REFRESH_MESSAGES_AND_SESSION),
    );
  }

  private async handleExtensionUiRequest(payload: any) {
    const id = extensionUiRequestId(payload);
    const method = String(payload?.method || "").trim();
    const ui = this.extensionBindings.uiContext;
    let response: RpcExtensionUiResponse | undefined;

    switch (method) {
      case "select": {
        if (!id) return;
        const value = ui?.select
          ? await ui.select(String(payload.title || ""), payload.options || [])
          : undefined;
        response =
          value === undefined || value === null
            ? { type: "extension_ui_response", id, cancelled: true }
            : { type: "extension_ui_response", id, value: String(value) };
        break;
      }
      case "confirm": {
        if (!id) return;
        const confirmed = ui?.confirm
          ? await ui.confirm(
              String(payload.title || ""),
              String(payload.message || ""),
            )
          : false;
        response = {
          type: "extension_ui_response",
          id,
          confirmed: !!confirmed,
        };
        break;
      }
      case "input": {
        if (!id) return;
        const value = ui?.input
          ? await ui.input(
              String(payload.title || ""),
              payload.placeholder === undefined
                ? undefined
                : String(payload.placeholder),
            )
          : undefined;
        response =
          value === undefined || value === null
            ? { type: "extension_ui_response", id, cancelled: true }
            : { type: "extension_ui_response", id, value: String(value) };
        break;
      }
      case "editor": {
        if (!id) return;
        const value = ui?.editor
          ? await ui.editor(
              String(payload.title || ""),
              payload.prefill === undefined
                ? undefined
                : String(payload.prefill),
            )
          : undefined;
        response =
          value === undefined || value === null
            ? { type: "extension_ui_response", id, cancelled: true }
            : { type: "extension_ui_response", id, value: String(value) };
        break;
      }
      case "notify":
        ui?.notify?.(String(payload.message || ""), payload.notifyType);
        return;
      case "setStatus":
        ui?.setStatus?.(String(payload.statusKey || ""), payload.statusText);
        return;
      case "setWorkingMessage":
        ui?.setWorkingMessage?.(
          payload.message === undefined ? undefined : String(payload.message),
        );
        return;
      case "setWorkingVisible":
        ui?.setWorkingVisible?.(Boolean(payload.visible));
        return;
      case "setWorkingIndicator":
        ui?.setWorkingIndicator?.(payload.options);
        return;
      case "setHiddenThinkingLabel":
        ui?.setHiddenThinkingLabel?.(
          payload.label === undefined ? undefined : String(payload.label),
        );
        return;
      case "setWidget":
        ui?.setWidget?.(String(payload.widgetKey || ""), payload.widgetLines, {
          placement: payload.widgetPlacement,
        });
        return;
      case "setFooter":
        ui?.setFooter?.(undefined);
        return;
      case "setHeader":
        ui?.setHeader?.(undefined);
        return;
      case "setTitle":
        ui?.setTitle?.(String(payload.title || ""));
        return;
      case "setToolsExpanded":
        ui?.setToolsExpanded?.(Boolean(payload.expanded));
        return;
      case "set_editor_text":
        ui?.setEditorText?.(String(payload.text || ""));
        return;
      default:
        response = cancelledExtensionUiResponse(payload);
    }

    if (response) await this.client.send(response);
  }

  private emitEvent(event: AgentEvent) {
    const listeners = [...this.listeners];
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  private getFrontendPhase(): RpcFrontendPhase {
    if (this.startupPending || this.sessionOperationPending) {
      return "starting";
    }
    if (!this.rpcConnected || this.recoveryPending) return "connecting";
    if (this.isCompacting) return "compacting";
    if (this.remoteTurnRunning) return "working";
    if (this.activeTurn) return "sending";
    return "idle";
  }

  getFrontendStatusEvent() {
    const phase = this.getFrontendPhase();
    if (phase === "idle") return null;
    const label = RPC_FRONTEND_PHASE_LABELS[phase];
    return {
      type: "rpc_frontend_status",
      phase,
      label,
      connected: this.rpcConnected,
    } as any;
  }

  private emitFrontendStatus(force = false) {
    const phase = this.getFrontendPhase();
    if (!force && phase === this.lastFrontendPhase) return;
    this.lastFrontendPhase = phase;
    const event = this.getFrontendStatusEvent();
    if (event) {
      this.emitEvent(event as AgentEvent);
      return;
    }
    this.emitEvent({ type: "rpc_frontend_status", phase: "idle" } as any);
  }

  private setSessionOperationPending(pending: boolean) {
    this.sessionOperationPending = pending;
    this.emitFrontendStatus(true);
  }

  private emitSessionResynced() {
    this.emitEvent({ type: "rpc_session_resynced" } as any);
  }

  private emitLocalUserMessage(text: string) {
    const nextText = String(text || "").trim();
    if (!nextText) return;
    this.emitEvent({ type: "rpc_local_user_message", text: nextText } as any);
  }

  private setRpcConnected(connected: boolean) {
    this.rpcConnected = connected;
    if (!connected) {
      this.remoteTurnRunning = false;
      this.activeTurn = null;
    }
    this.syncStreamingState();
  }

  private setRemoteTurnRunning(running: boolean) {
    this.remoteTurnRunning = running;
    if (running || !this.recoveryPending) {
      this.recoveringTurnPending = false;
    }
    this.syncStreamingState();
  }

  private syncStreamingState() {
    this.isStreaming = Boolean(
      (this.rpcConnected && (this.remoteTurnRunning || this.activeTurn)) ||
      (this.recoveryPending && this.recoveringTurnPending),
    );
    if (!this.isStreaming && !this.rpcConnected) this.activeTurn = null;
    this.emitFrontendStatus();
  }

  private ensureRequestTag(requestTag?: string) {
    const next = String(requestTag || "").trim();
    if (next) return next;
    this.nextRequestTagId += 1;
    return `rin-tui-${Date.now()}-${this.nextRequestTagId}`;
  }

  private clearWaitingDaemonState() {
    if (this.waitForDaemonHintTimer) clearTimeout(this.waitForDaemonHintTimer);
    this.waitForDaemonHintTimer = null;
    this.waitForDaemonPromise = null;
  }

  private async waitForDaemonAvailable() {
    if (
      this.client.isConnected() &&
      this.rpcConnected &&
      !this.recoveryPending
    ) {
      return;
    }
    if (this.waitForDaemonPromise) return await this.waitForDaemonPromise;
    this.emitEvent({
      type: "status",
      level: "warning",
      text: "Waiting daemon...",
    } as any);
    this.waitForDaemonHintTimer = setTimeout(() => {
      this.waitForDaemonHintTimer = null;
      this.emitEvent({
        type: "status",
        level: "warning",
        text: "Daemon is still unavailable after 30s. Try `rin doctor` or reopen Rin to enter temporary maintenance mode.",
      } as any);
    }, 30000);
    this.waitForDaemonPromise = this.ensureReconnectLoop().finally(() => {
      this.clearWaitingDaemonState();
    });
    return await this.waitForDaemonPromise;
  }

  private queueOfflineOperation(operation: PendingRpcOperation) {
    this.queuedOfflineOps.push(operation);
    if (!this.client.isConnected() || !this.rpcConnected) {
      void this.ensureReconnectLoop();
    }
    this.emitFrontendStatus(true);
  }

  private async sendOrQueue(operation: PendingRpcOperation) {
    if (operation.mode === "prompt" && !operation.streamingBehavior)
      this.emitLocalUserMessage(operation.message);
    if (
      !this.client.isConnected() ||
      !this.rpcConnected ||
      this.recoveryPending
    ) {
      this.queueOfflineOperation(operation);
      return;
    }

    if (this.clearQueuePromise) await this.clearQueuePromise;

    const tracksTurn =
      operation.mode === "prompt" && !operation.streamingBehavior;
    if (tracksTurn) {
      this.activeTurn = operation;
      this.syncStreamingState();
    }

    const sendOperation = async () => {
      await this.ensureRemoteSession();
      await this.call(operation.mode, {
        message: operation.message,
        images: operation.images,
        streamingBehavior: operation.streamingBehavior,
        source: operation.source,
        requestTag: operation.requestTag,
      });
    };

    try {
      await sendOperation();
    } catch (error: any) {
      const message = String(error?.message || error || "");
      if (/rin_tui_not_connected|rin_disconnected/.test(message)) {
        if (tracksTurn) {
          this.activeTurn = null;
          this.syncStreamingState();
        }
        this.queueOfflineOperation(operation);
        return;
      }
      if (tracksTurn) {
        this.activeTurn = null;
        this.syncStreamingState();
      }
      throw error;
    }
  }

  handleSessionUnavailable(options?: { transportClosed?: boolean }) {
    if (this.disposed) return;
    this.startupPending = false;
    this.recoveringTurnPending = Boolean(
      this.recoveringTurnPending ||
      this.remoteTurnRunning ||
      this.activeTurn ||
      this.isCompacting,
    );
    this.recoveryPending = true;
    this.activeTurn = null;
    this.remoteTurnRunning = false;
    this.isCompacting = false;
    this.isBashRunning = false;
    if (options?.transportClosed) {
      this.setRpcConnected(false);
      void this.ensureReconnectLoop();
      return;
    }
    this.syncStreamingState();
  }

  handleSessionRecovered() {
    if (this.disposed || !this.recoveryPending) return;
    void completeRpcRecovery(this).catch(() => {});
  }

  private handleConnectionLost() {
    this.handleSessionUnavailable({ transportClosed: true });
  }

  private ensureReconnectLoop() {
    if (this.disposed) return Promise.resolve();
    if (this.reconnectPromise) return this.reconnectPromise;
    this.reconnecting = true;
    this.emitFrontendStatus(true);
    this.reconnectPromise = (async () => {
      while (!this.disposed) {
        try {
          if (!this.client.isConnected()) {
            await this.client.connect();
          }
          if (
            !this.rpcConnected ||
            (this.recoveryPending && !this.restorePromise)
          ) {
            await this.handleConnectionRestored();
          }
          if (
            this.client.isConnected() &&
            this.rpcConnected &&
            !this.recoveryPending
          ) {
            return;
          }
        } catch {}
        await new Promise<void>((resolve) => {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            resolve();
          }, 1000);
        });
      }
      throw new Error("rin_tui_disposed");
    })().finally(() => {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectPromise = null;
      this.reconnecting = false;
      this.emitFrontendStatus(true);
    });
    return this.reconnectPromise;
  }

  private async handleConnectionRestored() {
    if (this.disposed) return;
    if (this.restorePromise) return await this.restorePromise;
    this.restorePromise = (async () => {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      try {
        if (this.sessionFile || this.sessionId) {
          await this.call("select_session", {
            sessionPath: this.sessionFile,
            sessionId: this.sessionId || undefined,
          });
        }
        this.setRpcConnected(true);
        this.recoveryPending = true;
        await completeRpcRecovery(this);
      } catch (error) {
        this.setRpcConnected(false);
        this.recoveryPending = true;
        throw error;
      }
    })().finally(() => {
      this.restorePromise = null;
    });
    return await this.restorePromise;
  }

  applyQueueUpdate(payload: any) {
    this.steeringMessages = normalizeQueuedMessages(payload?.steering);
    this.followUpMessages = normalizeQueuedMessages(payload?.followUp);
    this.syncPendingCount();
  }

  private emitQueueUpdate() {
    this.emitEvent({
      type: "queue_update",
      steering: [...this.steeringMessages],
      followUp: [...this.followUpMessages],
    } as any);
  }

  private getFrontendExtensionCommand(text: string) {
    if (!text.startsWith("/")) return undefined;
    const extensionRunner = this.extensionRunner;
    if (!extensionRunner?.getCommand) return undefined;
    const spaceIndex = text.indexOf(" ");
    const commandName =
      spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    return extensionRunner.getCommand(commandName);
  }

  private isFrontendExtensionCommand(text: string) {
    return Boolean(this.getFrontendExtensionCommand(text));
  }

  private async ensureRemoteSession() {
    if (this.sessionFile || this.sessionId) return;
    const data = await this.call("new_session", {
      resourceOptions: serializeRpcResourceOptions(this.extensionOptions),
    });
    if (data && data.cancelled) throw new Error("rin_new_session_cancelled");
    await this.refreshState(REFRESH_ALL);
  }

  private buildSessionCommandPayload(
    type: string,
    payload: Record<string, unknown>,
  ) {
    if (
      [
        "get_state",
        "new_session",
        "select_session",
        "attach_session",
        "switch_session",
        "get_commands",
        "get_resource_diagnostics",
      ].includes(type)
    ) {
      return {
        ...payload,
        resourceOptions:
          payload.resourceOptions ||
          serializeRpcResourceOptions(this.extensionOptions),
      };
    }
    return payload;
  }

  private async refreshResourceDiagnostics() {
    this.resourceSnapshot = normalizeRpcResourceSnapshot(
      await this.call("get_resource_diagnostics"),
    );
  }

  private async call(type: string, payload: Record<string, unknown> = {}) {
    const sessionScoped = isSessionScopedCommand(type);
    const send = async () =>
      await this.client.send({
        type,
        ...this.buildSessionCommandPayload(type, payload),
      });
    if (sessionScoped && !this.client.isConnected()) {
      await this.waitForDaemonAvailable();
    }
    let response: any;
    try {
      response = await send();
    } catch (error: any) {
      const message = String(error?.message || error || "");
      if (
        sessionScoped &&
        /rin_tui_not_connected|rin_disconnected|rin_session_recovering/.test(
          message,
        )
      ) {
        this.recoveryPending = true;
        this.emitFrontendStatus(true);
        await this.waitForDaemonAvailable();
        response = await send();
      } else {
        throw error;
      }
    }
    if (!response || response.success !== true) {
      throw new Error(String(response?.error || "rin_request_failed"));
    }
    return response.data;
  }

  private async refreshState(flags: RefreshFlags = {}) {
    this.applyState(await this.call("get_state"));
    const shouldRefreshSessionData = Boolean(flags.messages || flags.session);
    await Promise.all([
      flags.models ? this.modelRegistry.sync() : Promise.resolve(),
      shouldRefreshSessionData ? this.refreshSessionData() : Promise.resolve(),
    ]);
    this.lastSessionStats = this.computeSessionStats();
  }

  private queueRefreshState(flags: RefreshFlags = {}) {
    this.pendingRefreshFlags = {
      messages: this.pendingRefreshFlags.messages || flags.messages,
      models: this.pendingRefreshFlags.models || flags.models,
      session: this.pendingRefreshFlags.session || flags.session,
    };
    if (this.refreshLoopPromise) return this.refreshLoopPromise;
    this.refreshLoopPromise = (async () => {
      while (
        this.pendingRefreshFlags.messages ||
        this.pendingRefreshFlags.models ||
        this.pendingRefreshFlags.session
      ) {
        const next = this.pendingRefreshFlags;
        this.pendingRefreshFlags = {};
        try {
          await this.refreshState(next);
        } catch {}
      }
    })().finally(() => {
      this.refreshLoopPromise = null;
    });
    return this.refreshLoopPromise;
  }

  private applyState(state: any) {
    this.recoveringTurnPending = false;
    applyRpcSessionState(this as any, state);
    this.syncStreamingState();
  }

  private syncDerivedMessages() {
    const context = buildSessionContext(
      this.entries,
      this.leafId,
      this.entryById as any,
    );
    this.messages = Array.isArray(context?.messages) ? context.messages : [];
    this.state.messages = this.messages;
  }

  private async refreshSessionData() {
    const snapshot = await this.call("get_session_snapshot");
    applyRpcSessionTree(
      this as any,
      { entries: snapshot?.entries },
      { tree: snapshot?.tree, leafId: snapshot?.leafId },
    );
    this.syncDerivedMessages();
  }

  private getBranch(fromId?: string) {
    return getSessionBranch(this.entryById, this.leafId, fromId);
  }

  private computeSessionStats() {
    return computeSessionStats(
      this.model,
      this.sessionFile,
      this.sessionId,
      this.entries,
      this.getContextUsage(),
    );
  }

  private syncPendingCount() {
    this.pendingMessageCount =
      this.steeringMessages.length + this.followUpMessages.length;
  }
}
