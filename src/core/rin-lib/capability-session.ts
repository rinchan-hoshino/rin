import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type {
  RinCapabilityContext,
  RinCapabilityDefinition,
  RinCapabilityMode,
  RinHookHandler,
} from "./capability-types.js";
import { normalizeStringList } from "../text-utils.js";
import {
  attachRinCapabilityExtensionBridge,
  withRinEventMetadata,
} from "../pi/internal-extension-bridge.js";
import {
  getPiSessionExtensionCommandContextActions,
  getPiSessionExtensionMode,
  getPiSessionExtensionUIContext,
  readPiSessionBaseSystemPromptOptions,
  refreshPiSessionToolRegistry,
  shutdownPiSessionExtensionHost,
} from "../pi/session-host.js";

type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

type RegisteredTool = {
  definition: any;
  sourceName?: string;
};

type CoreActions = {
  sendMessage: (message: any, options?: any) => void;
  emitEvent: (event: any) => void;
  sendUserMessage: (content: any, options?: any) => void;
  appendEntry: <T = unknown>(customType: string, data?: T) => void;
  setSessionName: (name: string) => void;
  getSessionName: () => string | undefined;
  setLabel: (entryId: string, label: string | undefined) => void;
  getActiveTools: () => string[];
  getAllTools: () => any[];
  setActiveTools: (toolNames: string[]) => void;
  refreshTools: () => void;
  setModel: (model: any) => Promise<boolean>;
  getThinkingLevel: () => ThinkingLevel;
  setThinkingLevel: (level: ThinkingLevel) => void;
};

type ContextActions = {
  getModel: () => any;
  isIdle: () => boolean;
  getSignal: () => AbortSignal | undefined;
  abort: () => void;
  hasPendingMessages: () => boolean;
  shutdown: () => void;
  getContextUsage: () => any;
  compact: (options?: any) => void;
  getSystemPrompt: () => string;
  getSystemPromptOptions: () => any;
};

type CommandContextActions = {
  waitForIdle: () => Promise<void>;
  newSession: (options?: any) => Promise<{ cancelled: boolean }>;
  fork: (entryId: string) => Promise<{ cancelled: boolean }>;
  navigateTree: (
    targetId: string,
    options?: any,
  ) => Promise<{ cancelled: boolean }>;
  switchSession: (sessionPath: string) => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
};

export type RinCapabilitySet = {
  readonly cwd: string;
  readonly agentDir: string;
  bindCore: (
    coreActions?: Partial<CoreActions>,
    contextActions?: Partial<ContextActions>,
  ) => void;
  setUIContext: (uiContext?: any, mode?: RinCapabilityMode) => void;
  bindCommandContext: (actions?: Partial<CommandContextActions>) => void;
  hasHandlers: (eventName: string) => boolean;
  emit: (event: any) => Promise<any>;
  getToolDefinitions: () => any[];
  createContext: () => RinCapabilityContext;
  createCommandContext: () => any;
};

const noOpUIContext = {
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
  notify: () => {},
  onTerminalInput: () => () => {},
  setStatus: () => {},
  setWorkingMessage: () => {},
  setHiddenThinkingLabel: () => {},
  setWidget: () => {},
  setFooter: () => {},
  setHeader: () => {},
  setTitle: () => {},
  custom: async () => undefined,
  pasteToEditor: () => {},
  setEditorText: () => {},
  getEditorText: () => "",
  setEditorComponent: () => {},
};

const RIN_CAPABILITY_MODES = new Set<RinCapabilityMode>([
  "tui",
  "rpc",
  "json",
  "print",
]);

function normalizeCapabilityMode(value: unknown): RinCapabilityMode {
  const text = String(value || "").trim();
  return RIN_CAPABILITY_MODES.has(text as RinCapabilityMode)
    ? (text as RinCapabilityMode)
    : "print";
}

const noOpCoreActions: CoreActions = {
  sendMessage: () => {},
  emitEvent: () => {},
  sendUserMessage: () => {},
  appendEntry: () => {},
  setSessionName: () => {},
  getSessionName: () => undefined,
  setLabel: () => {},
  getActiveTools: () => [],
  getAllTools: () => [],
  setActiveTools: () => {},
  refreshTools: () => {},
  setModel: async () => false,
  getThinkingLevel: () => "medium",
  setThinkingLevel: () => {},
};

const noOpContextActions: ContextActions = {
  getModel: () => undefined,
  isIdle: () => true,
  getSignal: () => undefined,
  abort: () => {},
  hasPendingMessages: () => false,
  shutdown: () => {},
  getContextUsage: () => undefined,
  compact: () => {},
  getSystemPrompt: () => "",
  getSystemPromptOptions: () => ({}),
};

const noOpCommandContextActions: CommandContextActions = {
  waitForIdle: async () => {},
  newSession: async () => ({ cancelled: false }),
  fork: async () => ({ cancelled: false }),
  navigateTree: async () => ({ cancelled: false }),
  switchSession: async () => ({ cancelled: false }),
  reload: async () => {},
};

export function normalizeCapabilityNames(values: unknown): string[] {
  return Array.isArray(values)
    ? normalizeStringList(values, { lowercase: true })
    : [];
}

export function createRinCapabilitySet(options: {
  cwd: string;
  agentDir: string;
  sessionManager?: any;
  modelRegistry?: any;
  definitions: Array<RinCapabilityDefinition | void>;
  disabledNames?: string[];
}): RinCapabilitySet {
  const disabled = new Set(normalizeCapabilityNames(options.disabledNames));
  const handlers = new Map<string, RinHookHandler[]>();
  const tools = new Map<string, RegisteredTool>();
  let uiContext: any = noOpUIContext;
  let mode: RinCapabilityMode = "print";
  let coreActions: CoreActions = noOpCoreActions;
  let contextActions: ContextActions = noOpContextActions;
  let commandContextActions: CommandContextActions = noOpCommandContextActions;

  const createContext = (): RinCapabilityContext => {
    const getModel = contextActions.getModel;
    return {
      ui: uiContext,
      mode,
      hasUI: uiContext !== noOpUIContext,
      cwd: options.cwd,
      agentDir: options.agentDir,
      sessionManager: options.sessionManager,
      modelRegistry: options.modelRegistry,
      get model() {
        return getModel();
      },
      get frontend() {
        return (options.sessionManager as any)?.__rinFrontend;
      },

      isIdle: () => contextActions.isIdle(),
      signal: contextActions.getSignal(),
      abort: () => contextActions.abort(),
      hasPendingMessages: () => contextActions.hasPendingMessages(),
      shutdown: () => contextActions.shutdown(),
      getContextUsage: () => contextActions.getContextUsage(),
      compact: (compactOptions?: any) => contextActions.compact(compactOptions),
      getSystemPrompt: () => contextActions.getSystemPrompt(),
      getSystemPromptOptions: () => contextActions.getSystemPromptOptions(),
      getThinkingLevel: () => coreActions.getThinkingLevel(),
      emitEvent: (event: any) => coreActions.emitEvent(event),
    };
  };

  const emitHandlerError = (eventName: string, error: any) => {
    try {
      options.sessionManager?.appendCustomEntry?.("rin_core_capability_error", {
        event: eventName,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } catch {}
  };

  const capabilitySet: RinCapabilitySet = {
    cwd: options.cwd,
    agentDir: options.agentDir,
    bindCore(core?: Partial<CoreActions>, context?: Partial<ContextActions>) {
      coreActions = { ...noOpCoreActions, ...(core || {}) };
      contextActions = { ...noOpContextActions, ...(context || {}) };
    },
    setUIContext(nextUiContext?: any, nextMode?: RinCapabilityMode) {
      uiContext = nextUiContext || noOpUIContext;
      mode = normalizeCapabilityMode(nextMode);
    },
    bindCommandContext(actions?: Partial<CommandContextActions>) {
      commandContextActions = {
        ...noOpCommandContextActions,
        ...(actions || {}),
      };
    },
    hasHandlers(eventName: string) {
      return (handlers.get(String(eventName || "").trim()) || []).length > 0;
    },
    async emit(event: any) {
      const ctx = createContext();
      const eventName = String(event?.type || "");
      let result: any = undefined;
      for (const handler of handlers.get(eventName) || []) {
        try {
          const handlerResult = await handler(event, ctx);
          if (handlerResult) result = handlerResult;
        } catch (error: any) {
          emitHandlerError(eventName || "event", error);
          if (eventName === "session_before_compact") throw error;
        }
      }
      return result;
    },
    getToolDefinitions() {
      return Array.from(tools.values()).map((entry) => entry.definition);
    },
    createContext,
    createCommandContext() {
      return {
        ...createContext(),
        getSystemPromptOptions: () => contextActions.getSystemPromptOptions(),
        waitForIdle: () => commandContextActions.waitForIdle(),
        newSession: (sessionOptions?: any) =>
          commandContextActions.newSession(sessionOptions),
        fork: (entryId: string) => commandContextActions.fork(entryId),
        navigateTree: (targetId: string, navigationOptions?: any) =>
          commandContextActions.navigateTree(targetId, navigationOptions),
        switchSession: (sessionPath: string) =>
          commandContextActions.switchSession(sessionPath),
        reload: () => commandContextActions.reload(),
      };
    },
  };

  for (const definition of options.definitions) {
    const current = definition || {};
    const capabilityName = String(current.name || "")
      .trim()
      .toLowerCase();
    if (capabilityName && disabled.has(capabilityName)) continue;
    for (const tool of current.tools || []) {
      const toolName = String(tool?.name || "").trim();
      if (!toolName || tools.has(toolName)) continue;
      tools.set(toolName, { definition: tool, sourceName: current.name });
    }
    for (const [eventName, capabilityHandlers] of Object.entries(
      current.hooks || {},
    )) {
      const normalizedName = String(eventName || "").trim();
      if (!normalizedName || !Array.isArray(capabilityHandlers)) continue;
      handlers.set(normalizedName, [
        ...(handlers.get(normalizedName) || []),
        ...capabilityHandlers.filter(
          (handler) => typeof handler === "function",
        ),
      ]);
    }
  }

  return capabilitySet;
}

const RIN_CORE_EVENT_EMITTER_PATCH_KEY = Symbol.for(
  "rin.coreEventEmitterPatch",
);

type RinCoreEventEmitterPatchState = {
  listeners: Set<(event: any) => void>;
  originalSubscribe: (listener: (event: any) => void) => () => void;
};

function patchRinCoreEventEmitter(session: any) {
  if (!session || typeof session !== "object") return;
  const existing = session[RIN_CORE_EVENT_EMITTER_PATCH_KEY] as
    | RinCoreEventEmitterPatchState
    | undefined;
  if (existing) return;
  if (typeof session.subscribe !== "function") return;

  const state: RinCoreEventEmitterPatchState = {
    listeners: new Set(),
    originalSubscribe: session.subscribe.bind(session),
  };
  session[RIN_CORE_EVENT_EMITTER_PATCH_KEY] = state;
  session.subscribe = (listener: (event: any) => void) => {
    state.listeners.add(listener);
    const unsubscribeOriginal = state.originalSubscribe(listener);
    return () => {
      state.listeners.delete(listener);
      unsubscribeOriginal?.();
    };
  };
  session.__rinEmitCoreEvent = (event: any) => {
    for (const listener of Array.from(state.listeners)) {
      try {
        listener(event);
      } catch {}
    }
  };
}

function bindCapabilitySetToSession(
  capabilitySet: RinCapabilitySet,
  session: any,
) {
  capabilitySet.bindCore(
    {
      sendMessage: (message, options) => {
        session.sendCustomMessage?.(message, options).catch?.(() => {});
      },
      emitEvent: (event) => {
        session.__rinEmitCoreEvent?.(event);
      },
      sendUserMessage: (content, options) => {
        session.sendUserMessage?.(content, options).catch?.(() => {});
      },
      appendEntry: (customType, data) => {
        session.sessionManager?.appendCustomEntry?.(customType, data);
      },
      setSessionName: (name) => {
        session.sessionManager?.appendSessionInfo?.(name);
      },
      getSessionName: () => session.sessionManager?.getSessionName?.(),
      setLabel: (entryId, label) => {
        session.sessionManager?.appendLabelChange?.(entryId, label);
      },
      getActiveTools: () => session.getActiveToolNames?.() || [],
      getAllTools: () => session.getAllTools?.() || [],
      setActiveTools: (toolNames) => session.setActiveToolsByName?.(toolNames),
      refreshTools: () => refreshPiSessionToolRegistry(session),
      setModel: async (model) => {
        if (!session.modelRegistry?.hasConfiguredAuth?.(model)) return false;
        await session.setModel?.(model);
        return true;
      },
      getThinkingLevel: () => session.thinkingLevel,
      setThinkingLevel: (level) => session.setThinkingLevel?.(level),
    },
    {
      getModel: () => session.model,
      isIdle: () => !session.isStreaming,
      getSignal: () => session.agent?.signal,
      abort: () => {
        void session.abort?.().catch?.(() => {});
      },
      hasPendingMessages: () => session.pendingMessageCount > 0,
      shutdown: () => {
        shutdownPiSessionExtensionHost(session);
      },
      getContextUsage: () => session.getContextUsage?.(),
      compact: (compactOptions) => {
        void (async () => {
          try {
            const result = await session.compact?.(
              compactOptions?.customInstructions,
            );
            compactOptions?.onComplete?.(result);
          } catch (error: any) {
            compactOptions?.onError?.(
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        })();
      },
      getSystemPrompt: () => session.systemPrompt,
      getSystemPromptOptions: () =>
        readPiSessionBaseSystemPromptOptions(session, capabilitySet.cwd),
    },
  );
  capabilitySet.setUIContext(
    getPiSessionExtensionUIContext(session),
    getPiSessionExtensionMode(session),
  );
  capabilitySet.bindCommandContext(
    getPiSessionExtensionCommandContextActions(session),
  );
}

async function emitSessionStart(
  capabilitySet: RinCapabilitySet,
  reason: SessionStartReason,
  previousSessionFile?: string,
) {
  if (!capabilitySet.hasHandlers("session_start")) return;
  await capabilitySet.emit({
    type: "session_start",
    reason,
    previousSessionFile,
  });
}

function subscribeRinCapabilityEvents(
  session: any,
  capabilitySet: RinCapabilitySet,
) {
  if (session.__rinCapabilityEventSubscription) return;
  if (typeof session.subscribe !== "function") return;
  session.__rinCapabilityEventSubscription = session.subscribe((event: any) => {
    const type = String(event?.type || "");
    if (!type || type === "input" || type === "before_agent_start") return;
    if (!capabilitySet.hasHandlers(type)) return;
    void capabilitySet
      .emit(withRinEventMetadata(event, session))
      .catch(() => {});
  });
}

export async function attachRinCapabilitiesToSession(
  session: any,
  options: {
    capabilitySet: RinCapabilitySet;
    reason?: SessionStartReason;
    previousSessionFile?: string;
  },
) {
  const capabilitySet = options.capabilitySet;
  patchRinCoreEventEmitter(session);
  bindCapabilitySetToSession(capabilitySet, session);
  attachRinCapabilityExtensionBridge(session, capabilitySet);
  subscribeRinCapabilityEvents(session, capabilitySet);
  session.__rinCapabilities = capabilitySet;

  if (options.reason && options.reason !== "reload") {
    await emitSessionStart(
      capabilitySet,
      options.reason,
      options.previousSessionFile,
    );
  }

  if (session.__rinCapabilityReloadPatched) return { capabilitySet };
  session.__rinCapabilityReloadPatched = true;

  const originalReload =
    typeof session.reload === "function" ? session.reload.bind(session) : null;
  if (originalReload) {
    session.reload = async (...args: any[]) => {
      const result = await originalReload(...args);
      attachRinCapabilityExtensionBridge(session, capabilitySet);
      capabilitySet.setUIContext(
        getPiSessionExtensionUIContext(session),
        getPiSessionExtensionMode(session),
      );
      capabilitySet.bindCommandContext(
        getPiSessionExtensionCommandContextActions(session),
      );
      await emitSessionStart(capabilitySet, "reload");
      return result;
    };
  }

  return { capabilitySet };
}
