import type {
  AgentEvent,
  AgentMessage,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  buildContextEntries,
  ExtensionRunner,
} from "@earendil-works/pi-coding-agent";

import { asArray } from "../json-utils.js";
import { safeString } from "../text-utils.js";
import {
  getRuntimeSessionDir,
  resolveRuntimeProfile,
} from "../rin-lib/profile.js";
import { createRinCapabilityDefinitions } from "../rin-lib/runtime.js";
import { serializeRinToolStartupOptions } from "../rin-lib/tool-options.js";
import { isSessionScopedCommand } from "../rin-lib/rpc.js";
import type { RinRpcCommandType } from "../rin-lib/rpc-types.js";
import {
  formatRuntimeErrorForFrontendDisplay,
  rawErrorMessage,
} from "../rin-lib/user-facing-errors.js";
import {
  applyFrontendBuiltinCommandText,
  parseFrontendCompactCommand,
  resolveRinFrontendCommandResponses,
} from "../rin-frontend-sdk/command-responses.js";
import { classifyRinFrontendCommand } from "../rin-frontend-sdk/command-dispatcher.js";
import { executeRinFrontendInterruptIntent } from "../rin-frontend-sdk/frontend-lifecycle.js";
import { waitForFrontendInputSubmissionReady } from "../rin-frontend-sdk/input-submission.js";
import type { RpcFrontendClient } from "../rin-frontend-sdk/frontend-surface.js";
import { createModelRegistry } from "../rin-frontend-sdk/model-registry.js";
import {
  cycleRpcModel,
  cycleRpcThinkingLevel,
  getPersistentSettingsManager,
  persistRpcSettingsMutation,
  setRpcAutoCompaction,
  setRpcFollowUpMode,
  setRpcModel,
  setRpcSteeringMode,
  setRpcThinkingLevel,
} from "../rin-frontend-sdk/model-settings.js";
import {
  computeAvailableThinkingLevels,
  extractText,
  getLastAssistantText,
} from "../rin-frontend-sdk/session-helpers.js";
import {
  computeSessionStats,
  getContextUsage,
} from "../rin-frontend-sdk/stats.js";
import {
  applyRpcSessionState,
  applyRpcSessionTree,
  getSessionBranch,
} from "../rin-frontend-sdk/state-utils.js";
import { TUI_FRONTEND_IDENTITY } from "../rin-frontend-sdk/frontend-identity.js";
import { submitNativeFrontendPromptTurn } from "../rin-frontend-sdk/turn-driver.js";
import { handleRpcSessionEvent } from "./events.js";
import type { TuiResourceOptions } from "./cli-options.js";
type PendingRpcOperation = {
  mode: "prompt";
  message: string;
  images?: any[];
  streamingBehavior?: "steer" | "followUp";
  source?: string;
  requestTag?: string;
};
import { normalizeBoundSessionList } from "../session/listing.js";

type RpcExtensionBindings = {
  uiContext?: any;
  commandContextActions?: any;
  shutdownHandler?: () => void;
  onError?: (error: any) => void | Promise<void>;
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
  extensions: {
    extensions: any[];
    errors: any[];
    diagnostics: any[];
    commandDiagnostics: any[];
    shortcutDiagnostics: any[];
  };
};

function emptyRpcResourceSnapshot(): RpcResourceSnapshot {
  return {
    skills: { skills: [], diagnostics: [] },
    prompts: { prompts: [], diagnostics: [] },
    themes: { themes: [], diagnostics: [] },
    extensions: {
      extensions: [],
      errors: [],
      diagnostics: [],
      commandDiagnostics: [],
      shortcutDiagnostics: [],
    },
  };
}

function normalizeResourceSection(value: any, itemKey: string) {
  return {
    [itemKey]: asArray(value?.[itemKey]),
    diagnostics: asArray(value?.diagnostics),
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
      extensions: asArray(value?.extensions?.extensions),
      errors: asArray(value?.extensions?.errors),
      diagnostics: asArray(value?.extensions?.diagnostics),
      commandDiagnostics: asArray(value?.extensions?.commandDiagnostics),
      shortcutDiagnostics: asArray(value?.extensions?.shortcutDiagnostics),
    },
  };
}

function normalizeQueuedMessages(value: any) {
  return asArray(value).flatMap((item) => {
    const text = String(item ?? "");
    return text ? [text] : [];
  });
}

function serializeRpcResourceOptions(options: TuiResourceOptions) {
  return {
    ...serializeRinToolStartupOptions(options),
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
    ...(options.piStartupOptions !== undefined
      ? { piStartupOptions: options.piStartupOptions }
      : {}),
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
    getSystemPromptSource: () => undefined,
    getAppendSystemPromptSources: () => [],
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getPathMetadata: () => new Map(),
  };
}

const REFRESH_MESSAGES = { messages: true } as const;
const REFRESH_MODELS = { models: true } as const;
const REFRESH_SESSION = { session: true } as const;
const REFRESH_MESSAGES_AND_SESSION = { messages: true, session: true } as const;
const REFRESH_ALL = { messages: true, models: true, session: true } as const;

function isPromptSubmissionTimeout(message: string) {
  return /\b(?:rin_?timeout:prompt|timeout:\s*prompt)\b/.test(message);
}

function asRawRuntimeError(error: unknown, fallback = "unknown error") {
  if (error instanceof Error) return error;
  return new Error(rawErrorMessage(error) || fallback);
}

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
  if (typeof target.emitQueueUpdate === "function") {
    target.emitQueueUpdate();
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
    void executeRinFrontendInterruptIntent(this.client, "stop_turn").catch(
      () => {},
    );
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
  | "compacting"
  | "retrying"
  | "sending"
  | "working"
  | "connecting";

const RPC_FRONTEND_PHASE_LABELS: Record<
  Exclude<RpcFrontendPhase, "idle">,
  string
> = {
  connecting: "Connecting",
  starting: "Starting",
  compacting: "Compacting context",
  retrying: "Retrying",
  sending: "Sending",
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
  public modelRuntime: any;
  public resourceLoader: any;
  public sessionManager: any;

  public scopedModels: any[] = [];
  public promptTemplates: any[] = [];
  public extensionRunner: any;
  public activeToolsCache: string[] = [];
  public allToolsCache: any[] = [];
  public model: any = null;
  public thinkingLevel: ThinkingLevel = "medium";
  public steeringMode: "all" | "one-at-a-time" = "all";
  public followUpMode: "all" | "one-at-a-time" = "one-at-a-time";
  public systemPrompt = "";
  public isStreaming = false;
  public isCompacting = false;
  public compactionReason = "";
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
  private commandCatalog: any[] = [];
  private reconnecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectPromise: Promise<void> | null = null;
  private activeTurn: PendingRpcOperation | null = null;
  private rpcConnected = false;
  private remoteTurnRunning = false;
  public agentStreaming = false;
  public backendWorking = false;
  private workingVisiblePreference = true;
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
  private coreToolDefinitions = new Map<string, any>();
  private frontendNativeExtensionRunner?: any;

  constructor(
    public client: RpcFrontendClient,
    extensionOptions: string[] | Partial<TuiResourceOptions> = [],
    frontendExtensions?: { extensions: any[]; runtime: any },
  ) {
    const normalizedExtensionOptions = Array.isArray(extensionOptions)
      ? { additionalExtensionPaths: extensionOptions }
      : extensionOptions;
    this.extensionOptions = {
      ...serializeRinToolStartupOptions(normalizedExtensionOptions),
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
    this.modelRuntime = this.modelRegistry;
    this.resourceLoader = createRpcResourceLoader(() => this.resourceSnapshot);
    this.sessionManager = {
      getSessionFile: () => this.sessionFile,
      getSessionId: () => this.sessionId,
      isPersisted: () => Boolean(this.sessionFile),
      usesDefaultSessionDir: () => false,
      getHeader: () => null,
      getEntry: (id: string) => this.entryById.get(id),
      getLabel: (id: string) => this.labelsById.get(id),
      getBranch: (fromId?: string) => this.getBranch(fromId),
      buildContextEntries: () =>
        buildContextEntries(this.entries, this.leafId, this.entryById),
      buildSessionContext: () => this.buildSessionContext(),
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
    this.coreToolDefinitions = this.createCoreToolDefinitions();
    if (frontendExtensions) {
      this.frontendNativeExtensionRunner = new ExtensionRunner(
        frontendExtensions.extensions,
        frontendExtensions.runtime,
        getRuntimeProfile().cwd,
        this.sessionManager,
        this.modelRegistry,
      );
      for (const [name, value] of Object.entries(
        this.extensionOptions.extensionFlagValues ?? {},
      )) {
        this.frontendNativeExtensionRunner.setFlagValue(name, value);
      }
    }
    this.extensionRunner = this.createPassiveExtensionRunner();
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
      if (event.type === "extension_ui_request") {
        this.handleRpcEvent((event as any).payload);
        return;
      }
      if (event.type === "extension_error") {
        this.emitEvent({
          type: "status",
          level: "error",
          text: String((event as any).payload?.error || "Extension error"),
        } as any);
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
    if (
      expandPromptTemplates &&
      (await this.isDaemonRunnableSlashCommand(message).catch(() => false))
    ) {
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

  async steer(
    message: string,
    images?: any[],
    options?: { source?: string; requestTag?: string },
  ) {
    await this.prompt(message, {
      images,
      source: options?.source,
      requestTag: options?.requestTag,
      streamingBehavior: "steer",
      expandPromptTemplates: false,
    });
  }

  async followUp(
    message: string,
    images?: any[],
    options?: { source?: string; requestTag?: string },
  ) {
    await this.prompt(message, {
      images,
      source: options?.source,
      requestTag: options?.requestTag,
      streamingBehavior: "followUp",
      expandPromptTemplates: false,
    });
  }

  clearQueue() {
    const queued = this.visibleQueuedMessages();
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
    return this.visibleQueuedMessages().steering;
  }
  getFollowUpMessages() {
    return this.visibleQueuedMessages().followUp;
  }
  async abort() {
    this.activeTurn = null;
    this.remoteTurnRunning = false;
    this.agentStreaming = false;
    this.isStreaming = false;
    this.isCompacting = false;
    this.isBashRunning = false;
    this.retryAttempt = 0;
    this.syncStreamingState();
    void executeRinFrontendInterruptIntent(this.client, "stop_turn").catch(
      () => {},
    );
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
        frontendIdentity: TUI_FRONTEND_IDENTITY,
      });
      if (!data?.cancelled) {
        this.sessionFile = safeString(data?.sessionFile).trim() || undefined;
        this.sessionId = safeString(data?.sessionId).trim() || this.sessionId;
      }
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
        frontendIdentity: TUI_FRONTEND_IDENTITY,
      });
      if (!data?.cancelled) {
        this.sessionFile =
          safeString(data?.sessionFile).trim() ||
          safeString(sessionPath).trim() ||
          undefined;
        this.sessionId = safeString(data?.sessionId).trim() || this.sessionId;
      }
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

  async listSessionPage(
    scope: "all" = "all",
    options: { offset?: number; limit?: number } = {},
  ) {
    if (!this.client.isConnected()) {
      await this.waitForDaemonAvailable();
    }
    const data = await this.call("list_sessions", { scope, ...options });
    const sessions = normalizeBoundSessionList(data?.sessions);
    const offset = Number.isFinite(Number(data?.offset))
      ? Math.max(0, Number(data.offset))
      : options.offset || 0;
    const limit = Number.isFinite(Number(data?.limit))
      ? Math.max(1, Number(data.limit))
      : options.limit || sessions.length;
    const total = Number.isFinite(Number(data?.total))
      ? Math.max(0, Number(data.total))
      : sessions.length;
    const nextOffset = Number.isFinite(Number(data?.nextOffset))
      ? Math.max(0, Number(data.nextOffset))
      : offset + sessions.length;
    return {
      sessions,
      offset,
      limit,
      total,
      hasMore: Boolean(data?.hasMore) || nextOffset < total,
      nextOffset,
    };
  }

  async listSessions(
    scope: "all" = "all",
    _onProgress?: (loaded: number, total: number) => void,
  ) {
    return (await this.listSessionPage(scope)).sessions;
  }

  async callRpcSettingsMutation(
    command: Record<string, unknown> & { type: RinRpcCommandType },
  ) {
    return await this.call(command.type, command, { retryOnReconnect: false });
  }

  private reportRpcSettingsMutation<T>(mutation: Promise<T>): Promise<T> {
    void mutation.catch((error) => {
      this.emitEvent({
        type: "rpc_settings_mutation_error",
        error: formatRuntimeErrorForFrontendDisplay(error),
      } as any);
    });
    return mutation;
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
    return this.reportRpcSettingsMutation(
      setRpcThinkingLevel(this as any, level),
    );
  }

  async cycleThinkingLevel(): Promise<ThinkingLevel | undefined> {
    return await cycleRpcThinkingLevel(this as any);
  }

  getAvailableThinkingLevels() {
    return computeAvailableThinkingLevels(this.model);
  }

  setSteeringMode(mode: "all" | "one-at-a-time") {
    return this.reportRpcSettingsMutation(
      setRpcSteeringMode(this as any, mode),
    );
  }

  setFollowUpMode(mode: "all" | "one-at-a-time") {
    return this.reportRpcSettingsMutation(
      setRpcFollowUpMode(this as any, mode),
    );
  }

  async compact(customInstructions?: string) {
    const data = await this.client.compact(customInstructions);
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
    return data;
  }

  abortCompaction() {
    void executeRinFrontendInterruptIntent(
      this.client,
      "cancel_compaction",
    ).catch(() => {});
  }
  abortBranchSummary() {}

  setAutoCompactionEnabled(enabled: boolean) {
    return this.reportRpcSettingsMutation(
      setRpcAutoCompaction(this as any, enabled),
    );
  }

  async executeBash(
    command: string,
    _onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean },
  ) {
    this.isBashRunning = true;
    try {
      const data = await this.call("bash", {
        command,
        excludeFromContext: options?.excludeFromContext,
      });
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
    this.activeToolsCache = asArray(data?.tools);
    return this.activeToolsCache;
  }

  async getAllTools() {
    const data = await this.call("get_all_tools");
    this.allToolsCache = asArray(data?.tools);
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
    this.allToolsCache = asArray(data?.tools);
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
    const commandResponses = resolveRinFrontendCommandResponses();
    if (trimmed === "/abort") {
      await this.abort();
      return applyFrontendBuiltinCommandText(
        "abort",
        { handled: true },
        commandResponses,
      );
    }
    if (trimmed === "/new") {
      const completed = await this.newSession();
      return applyFrontendBuiltinCommandText(
        "new",
        { handled: true, cancelled: !completed },
        commandResponses,
      );
    }
    const compactCommand = parseFrontendCompactCommand(trimmed);
    if (compactCommand.compact) {
      const data: any = await this.compact(compactCommand.customInstructions);
      return applyFrontendBuiltinCommandText(
        "compact",
        { ...data, handled: true },
        commandResponses,
        { preferConfiguredText: true },
      );
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
            : commandResponses.newCancelled,
        };
      }
    }
    await this.ensureRemoteSession({ persist: true });
    const data = await this.call("run_command", { commandLine });
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
    return data;
  }

  async shutdownSession() {
    if (!this.client.isConnected()) return;
    await this.call("shutdown_session");
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
    void executeRinFrontendInterruptIntent(this.client, "cancel_retry").catch(
      () => {},
    );
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
    const name = String(toolName || "").trim();
    return (
      this.coreToolDefinitions.get(name) ??
      this.frontendNativeExtensionRunner?.getToolDefinition(name)
    );
  }

  private createCoreToolDefinitions() {
    const profile = getRuntimeProfile();
    const definitions = [
      ...createRinCapabilityDefinitions({
        cwd: profile.cwd,
        agentDir: profile.agentDir,
        getThinkingLevel: () => this.thinkingLevel,
        sendMessage: (message, messageOptions) => {
          this.sendCustomMessage?.(message, messageOptions).catch?.(() => {});
        },
        emitEvent: (event) => {
          this.emitEvent(event);
        },
      }),
    ];
    const tools = new Map<string, any>();
    for (const definition of definitions) {
      for (const tool of definition.tools || []) {
        const name = String(tool?.name || "").trim();
        if (name && !tools.has(name)) tools.set(name, tool);
      }
    }
    return tools;
  }

  private buildSessionContext() {
    return {
      messages: getSessionBranch(this.entryById, this.leafId).flatMap(
        (entry: any) =>
          entry?.type === "message" && entry.message ? [entry.message] : [],
      ),
    };
  }

  private createPassiveExtensionRunner() {
    return {
      getRegisteredCommands: () =>
        this.commandCatalog
          .filter((command) => String(command?.source || "") === "extension")
          .map((command) => this.toPassiveExtensionCommand(command)),
      getCommand: (name: string) => {
        const commandName = String(name || "");
        const command = this.commandCatalog.find(
          (entry) =>
            String(entry?.source || "") === "extension" &&
            String(entry?.name || "") === commandName,
        );
        return command ? this.toPassiveExtensionCommand(command) : undefined;
      },
      getCommandDiagnostics: () =>
        this.resourceSnapshot.extensions.commandDiagnostics,
      getShortcutDiagnostics: () =>
        this.frontendNativeExtensionRunner?.getShortcutDiagnostics?.() ??
        this.resourceSnapshot.extensions.shortcutDiagnostics,
      getShortcuts: (resolvedKeybindings: unknown) =>
        this.frontendNativeExtensionRunner?.getShortcuts?.(
          resolvedKeybindings,
        ) ?? new Map(),
      getMessageRenderer: (customType: string) =>
        this.frontendNativeExtensionRunner?.getMessageRenderer?.(customType),
      getMarkdownTransformers: () =>
        this.frontendNativeExtensionRunner?.getMarkdownTransformers?.() ?? [],
      getEntryRenderer: (customType: string) =>
        this.frontendNativeExtensionRunner?.getEntryRenderer?.(customType),
      getFlags: () =>
        this.frontendNativeExtensionRunner?.getFlags?.() ?? new Map(),
      getFlagValues: () =>
        this.frontendNativeExtensionRunner?.getFlagValues?.() ?? new Map(),
      getModelRegistry: () => this.modelRegistry,
      emitUserBash: async () => null,
      getToolDefinition: (toolName: string) => this.getToolDefinition(toolName),
      getAllRegisteredTools: () =>
        this.frontendNativeExtensionRunner?.getAllRegisteredTools?.() ?? [],
      invalidate: () => this.frontendNativeExtensionRunner?.invalidate?.(),
    };
  }

  private toPassiveExtensionCommand(command: any) {
    const name = String(command?.name || "");
    return {
      name,
      invocationName: name,
      description:
        typeof command?.description === "string"
          ? command.description
          : undefined,
      sourceInfo: command?.sourceInfo,
      getArgumentCompletions: async (argumentPrefix: string) => {
        const data = await this.call("get_command_argument_completions", {
          commandName: name,
          argumentPrefix,
        });
        return Array.isArray(data?.items) ? asArray(data.items) : null;
      },
    };
  }

  async reload() {
    await this.modelRegistry.sync();
    await this.call("reload").catch(() => {});
    await this.refreshDaemonCommandCatalog().catch(() => {});
    await this.refreshResourceDiagnostics().catch(() => {});
    await this.refreshState(REFRESH_MESSAGES_AND_SESSION);
  }

  async shutdownLocalExtensions(_event: Record<string, unknown>) {
    return false;
  }

  async bindExtensions(bindings: RpcExtensionBindings = {}) {
    this.extensionBindings = {
      ...this.extensionBindings,
      ...bindings,
    };
    this.syncWorkingPresentation();
    await Promise.all([
      this.refreshDaemonCommandCatalog().catch(() => {}),
      this.refreshResourceDiagnostics().catch(() => {}),
    ]);
  }

  private formatExtensionUiFailure(error: unknown) {
    try {
      return formatRuntimeErrorForFrontendDisplay(error);
    } catch {
      return "unknown error";
    }
  }

  private emitExtensionUiFailureStatus(
    detail: string,
    reportingError?: unknown,
  ) {
    const reportingDetail = reportingError
      ? `. Error reporter also failed: ${this.formatExtensionUiFailure(reportingError)}`
      : "";
    const text = `Extension UI request failed: ${detail}${reportingDetail}`;
    try {
      this.emitEvent({ type: "status", level: "error", text } as any);
    } catch {
      try {
        process.stderr.write(`\nRin TUI error\n${text}\n`);
      } catch {}
    }
  }

  private async reportExtensionUiRequestFailure(payload: any, error: unknown) {
    const detail = this.formatExtensionUiFailure(error);
    try {
      const onError = this.extensionBindings.onError;
      if (!onError) {
        this.emitExtensionUiFailureStatus(detail);
        return;
      }
      await onError({
        extensionPath: "rpc:extension_ui_request",
        event: payload?.method || "extension_ui_request",
        error: detail,
      });
    } catch (reportingError) {
      this.emitExtensionUiFailureStatus(detail, reportingError);
    }
  }

  private handleRpcEvent(payload: any) {
    if (payload?.type === "extension_ui_request") {
      void this.handleExtensionUiRequest(payload)
        .catch((error) => this.reportExtensionUiRequestFailure(payload, error))
        .catch((error) => {
          const detail = this.formatExtensionUiFailure(error);
          try {
            process.stderr.write(
              `\nRin TUI error\nFailed to report extension UI request failure: ${detail}\n`,
            );
          } catch {}
        });
      if (typeof payload.working === "boolean") {
        this.setBackendWorking(payload.working);
      }
      return;
    }
    void handleRpcSessionEvent(
      this as any,
      payload,
      () => this.queueRefreshStateAndRender(REFRESH_MESSAGES),
      () => this.queueRefreshStateAndRender(REFRESH_MESSAGES_AND_SESSION),
    ).catch(() => {});
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
      case "rinCommandResult": {
        const fallbackText = String(
          payload.result?.fallbackText || payload.result?.text || "",
        ).trim();
        if (fallbackText) ui?.notify?.(fallbackText, "info");
        return;
      }
      case "setStatus":
        ui?.setStatus?.(String(payload.statusKey || ""), payload.statusText);
        return;
      case "setWorkingMessage":
        ui?.setWorkingMessage?.(
          payload.message === undefined ? undefined : String(payload.message),
        );
        return;
      case "setWorkingVisible":
        this.setWorkingVisiblePreference(Boolean(payload.visible));
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
    if (this.retryAttempt > 0) return "retrying";
    if (this.backendWorking) return "working";
    if (this.activeTurn) return "sending";
    return "idle";
  }

  getFrontendStatusEvent() {
    const phase = this.getFrontendPhase();
    if (phase === "idle") return null;
    const label =
      phase === "compacting" &&
      this.compactionReason &&
      this.compactionReason !== "manual"
        ? "Auto compacting context"
        : RPC_FRONTEND_PHASE_LABELS[phase];
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

  private setRpcConnected(connected: boolean) {
    this.rpcConnected = connected;
    if (!connected) {
      this.remoteTurnRunning = false;
      this.agentStreaming = false;
      this.isStreaming = false;
      this.activeTurn = null;
    }
    this.syncStreamingState();
  }

  setTurnActive(active: boolean) {
    this.remoteTurnRunning = active;
    if (active || !this.recoveryPending) {
      this.recoveringTurnPending = false;
    }
    this.syncStreamingState();
  }

  setAgentStreaming(streaming: boolean) {
    this.agentStreaming = streaming;
    this.syncStreamingState();
  }

  setBackendWorking(working: boolean) {
    this.backendWorking = working;
    this.syncWorkingPresentation();
    this.emitFrontendStatus();
  }

  private setWorkingVisiblePreference(visible: boolean) {
    this.workingVisiblePreference = visible;
    this.syncWorkingPresentation();
  }

  private syncWorkingPresentation() {
    this.extensionBindings.uiContext?.setWorkingVisible?.(
      this.backendWorking && this.workingVisiblePreference,
    );
  }

  private syncStreamingState() {
    this.isStreaming = Boolean(
      (this.rpcConnected &&
        (this.agentStreaming || this.remoteTurnRunning || this.activeTurn)) ||
      (this.recoveryPending && this.recoveringTurnPending),
    );
    if (!this.rpcConnected) this.activeTurn = null;
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

  private async sendOrQueue(operation: PendingRpcOperation) {
    if (
      !this.client.isConnected() ||
      !this.rpcConnected ||
      this.recoveryPending
    ) {
      throw new Error("rin_frontend_disconnected");
    }

    if (this.clearQueuePromise) await this.clearQueuePromise;

    const tracksTurn =
      operation.mode === "prompt" && !operation.streamingBehavior;
    if (tracksTurn) {
      this.activeTurn = operation;
      this.syncStreamingState();
    }

    const sendOperation = async () => {
      await this.ensureRemoteSession({
        persist: operation.mode === "prompt",
      });
      if (operation.mode === "prompt") {
        await submitNativeFrontendPromptTurn(
          {
            prompt: async (text, options = {}) => {
              await this.call("prompt", { message: text, ...options });
            },
          },
          {
            text: operation.message,
            images: operation.images,
            streamingBehavior: undefined,
            source: operation.source,
            requestTag: operation.requestTag,
            sessionFile: this.sessionFile,
            gate: {
              isCompacting: () => this.isCompacting,
              onWaiting: () => this.emitFrontendStatus(true),
            },
          },
        );
        return;
      }
      await waitForFrontendInputSubmissionReady({
        isCompacting: () => this.isCompacting,
        onWaiting: () => this.emitFrontendStatus(true),
      });
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
      const message = rawErrorMessage(error);
      if (/rin_tui_not_connected|rin_disconnected/.test(message)) {
        if (tracksTurn) {
          this.activeTurn = null;
          this.syncStreamingState();
        }
        throw asRawRuntimeError(error);
      }
      if (operation.mode === "prompt" && isPromptSubmissionTimeout(message)) {
        this.handleSessionUnavailable();
        throw asRawRuntimeError(error);
      }
      if (tracksTurn) {
        this.activeTurn = null;
        this.syncStreamingState();
      }
      throw asRawRuntimeError(error);
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
    this.agentStreaming = false;
    this.isStreaming = false;
    this.isCompacting = false;
    this.isBashRunning = false;
    if (options?.transportClosed) {
      this.setRpcConnected(false);
      this.startReconnectLoop();
      return;
    }
    this.syncStreamingState();
    this.startReconnectLoop();
  }

  private startReconnectLoop() {
    const reconnectPromise = this.ensureReconnectLoop();
    void reconnectPromise?.catch((error) => {
      if (!/\brin_tui_disposed\b/.test(rawErrorMessage(error))) throw error;
    });
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
          try {
            await this.call("select_session", {
              sessionPath: this.sessionFile,
              sessionId: this.sessionId || undefined,
            });
          } catch (error) {
            if (
              this.sessionFile ||
              !/\brin_no_attached_session\b/.test(rawErrorMessage(error))
            ) {
              throw error;
            }
            // An in-memory session id belongs to one daemon process. If that
            // daemon was replaced, create a fresh ephemeral session instead of
            // retrying an identifier that can no longer be resolved.
            this.sessionId = undefined;
            await this.ensureRemoteSession();
          }
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
    const visible = this.visibleQueuedMessages();
    this.emitEvent({
      type: "queue_update",
      steering: visible.steering,
      followUp: visible.followUp,
    } as any);
  }

  private visibleQueuedMessages() {
    return {
      steering: [...this.steeringMessages],
      followUp: [...this.followUpMessages],
    };
  }

  private parseSlashCommandName(text: string) {
    const trimmed = String(text || "").trim();
    if (!trimmed.startsWith("/")) return "";
    const spaceIndex = trimmed.indexOf(" ");
    return spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex);
  }

  private async refreshDaemonCommandCatalog() {
    const data = await this.call("get_commands");
    this.commandCatalog = asArray(data?.commands);
    return this.commandCatalog;
  }

  private async isDaemonRunnableSlashCommand(text: string) {
    const initialRoute = classifyRinFrontendCommand(text);
    if (initialRoute.kind === "frontend" || initialRoute.kind === "daemon") {
      return true;
    }
    if (!initialRoute.name) return false;
    const commands = await this.refreshDaemonCommandCatalog();
    return classifyRinFrontendCommand(text, commands).kind === "daemon";
  }

  private async ensureRemoteSession(options: { persist?: boolean } = {}) {
    if (this.sessionFile || (!options.persist && this.sessionId)) return;
    const data = await this.call("new_session", {
      resourceOptions: serializeRpcResourceOptions(this.extensionOptions),
      frontendIdentity: TUI_FRONTEND_IDENTITY,
    });
    if (data && data.cancelled) throw new Error("rin_new_session_cancelled");
    await this.refreshState(REFRESH_ALL);
  }

  private buildSessionCommandPayload(
    type: string,
    payload: Record<string, unknown>,
  ) {
    const frontendScoped = [
      "new_session",
      "select_session",
      "switch_session",
      "shutdown_session",
      "terminate_session",
    ].includes(type)
      ? { frontendIdentity: TUI_FRONTEND_IDENTITY }
      : {};
    const scopedPayload: Record<string, unknown> = {
      ...frontendScoped,
      ...payload,
    };
    const withResources = [
      "get_state",
      "new_session",
      "select_session",
      "attach_session",
      "switch_session",
      "get_commands",
      "get_resource_diagnostics",
      "get_command_argument_completions",
    ].includes(type)
      ? {
          ...scopedPayload,
          resourceOptions:
            payload.resourceOptions ||
            serializeRpcResourceOptions(this.extensionOptions),
        }
      : scopedPayload;
    const hasExplicitSessionTarget = Boolean(
      withResources.sessionFile ||
      withResources.sessionPath ||
      withResources.sessionId,
    );
    const shouldAttachSessionFile =
      isSessionScopedCommand(type) &&
      type !== "new_session" &&
      !["select_session", "attach_session", "switch_session"].includes(type) &&
      !hasExplicitSessionTarget &&
      this.sessionFile;
    return shouldAttachSessionFile
      ? { ...withResources, sessionFile: this.sessionFile }
      : withResources;
  }

  private async refreshResourceDiagnostics() {
    this.resourceSnapshot = normalizeRpcResourceSnapshot(
      await this.call("get_resource_diagnostics"),
    );
  }

  private async call(
    type: RinRpcCommandType,
    payload: Record<string, unknown> = {},
    options: { retryOnReconnect?: boolean } = {},
  ) {
    const sessionScoped = isSessionScopedCommand(type);
    const send = async () =>
      await this.client.send({
        type,
        ...this.buildSessionCommandPayload(type, payload),
      });
    if (sessionScoped && !this.client.isConnected()) {
      if (options.retryOnReconnect === false) {
        throw new Error("rin_tui_not_connected");
      }
      await this.waitForDaemonAvailable();
    }
    let response: any;
    try {
      response = await send();
    } catch (error: any) {
      const message = rawErrorMessage(error);
      if (
        sessionScoped &&
        /rin_tui_not_connected|rin_disconnected|rin_session_recovering/.test(
          message,
        )
      ) {
        this.recoveryPending = true;
        this.emitFrontendStatus(true);
        if (
          options.retryOnReconnect === false ||
          this.restorePromise ||
          this.reconnectPromise
        ) {
          throw asRawRuntimeError(error);
        }
        await this.waitForDaemonAvailable();
        response = await send();
      } else {
        throw asRawRuntimeError(error);
      }
    }
    if (!response || response.success !== true) {
      throw asRawRuntimeError(response?.error || "rin_request_failed");
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

  private queueRefreshStateAndRender(flags: RefreshFlags = {}) {
    return this.queueRefreshState(flags).then(() => {
      this.emitFrontendStatus(true);
    });
  }

  private applyState(state: any) {
    this.recoveringTurnPending = false;
    applyRpcSessionState(this as any, state);
    this.syncStreamingState();
  }

  private syncDerivedMessages() {
    const context = this.buildSessionContext();
    this.messages = asArray(context?.messages);
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
    const visible = this.visibleQueuedMessages();
    this.pendingMessageCount =
      visible.steering.length + visible.followUp.length;
  }
}
