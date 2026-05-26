import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type {
  RinCapabilityContext,
  RinCapabilityDefinition,
  RinHookHandler,
} from "./capability-types.js";
import { normalizeStringList } from "../text-utils.js";

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
  setUIContext: (uiContext?: any) => void;
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
  let coreActions: CoreActions = noOpCoreActions;
  let contextActions: ContextActions = noOpContextActions;
  let commandContextActions: CommandContextActions = noOpCommandContextActions;

  const createContext = (): RinCapabilityContext => {
    const getModel = contextActions.getModel;
    return {
      ui: uiContext,
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
    setUIContext(nextUiContext?: any) {
      uiContext = nextUiContext || noOpUIContext;
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
      let result: any = undefined;
      for (const handler of handlers.get(String(event?.type || "")) || []) {
        try {
          const handlerResult = await handler(event, ctx);
          if (handlerResult) result = handlerResult;
        } catch (error: any) {
          emitHandlerError(String(event?.type || "event"), error);
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

const RIN_EXTENSION_RUNNER_EVENTS = new Set<string>(["session_before_compact"]);
const RIN_EXTENSION_RUNNER_BEFORE_EVENTS = new Set<string>([
  "session_before_compact",
]);
const RIN_EXTENSION_RUNNER_PATCH_KEY = Symbol.for(
  "rin.capabilityExtensionRunnerPatch",
);

type RinExtensionRunnerPatchState = {
  capabilitySet: RinCapabilitySet;
  session: any;
  originalHasHandlers: (eventName: string) => boolean;
  originalEmit: (event: any) => Promise<any>;
};

function withRinEventMetadata(event: any, session: any) {
  const type = String(event?.type || "").trim();
  if (
    type !== "session_before_compact" ||
    !event ||
    typeof event !== "object" ||
    event.reason
  ) {
    return event;
  }
  return {
    ...event,
    reason: String(session?.__rinCurrentCompactionReason || "").trim(),
  };
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

function patchRinCapabilityExtensionRunner(
  session: any,
  capabilitySet: RinCapabilitySet,
) {
  const runner = session?._extensionRunner;
  if (!runner || typeof runner !== "object") return;
  const existing = runner[RIN_EXTENSION_RUNNER_PATCH_KEY] as
    | RinExtensionRunnerPatchState
    | undefined;
  if (existing) {
    existing.capabilitySet = capabilitySet;
    existing.session = session;
    return;
  }
  if (
    typeof runner.hasHandlers !== "function" ||
    typeof runner.emit !== "function"
  ) {
    return;
  }

  const state: RinExtensionRunnerPatchState = {
    capabilitySet,
    session,
    originalHasHandlers: runner.hasHandlers.bind(runner),
    originalEmit: runner.emit.bind(runner),
  };
  runner[RIN_EXTENSION_RUNNER_PATCH_KEY] = state;

  runner.hasHandlers = (eventName: string) => {
    const type = String(eventName || "").trim();
    return (
      state.originalHasHandlers(eventName) ||
      (RIN_EXTENSION_RUNNER_EVENTS.has(type) &&
        state.capabilitySet.hasHandlers(type))
    );
  };

  runner.emit = async (event: any) => {
    const result = await state.originalEmit(event);
    const type = String(event?.type || "").trim();
    if (
      !RIN_EXTENSION_RUNNER_EVENTS.has(type) ||
      !state.capabilitySet.hasHandlers(type)
    ) {
      return result;
    }
    if (RIN_EXTENSION_RUNNER_BEFORE_EVENTS.has(type) && result?.cancel) {
      return result;
    }
    const rinResult = await state.capabilitySet.emit(
      withRinEventMetadata(event, state.session),
    );
    if (!RIN_EXTENSION_RUNNER_BEFORE_EVENTS.has(type)) {
      return result || rinResult;
    }
    if (rinResult?.cancel || rinResult?.compaction) {
      return rinResult;
    }
    return result || rinResult;
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
      refreshTools: () => session._refreshToolRegistry?.(),
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
        session._extensionShutdownHandler?.();
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
    },
  );
  capabilitySet.setUIContext(session._extensionUIContext);
  capabilitySet.bindCommandContext(session._extensionCommandContextActions);
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
  patchRinCapabilityExtensionRunner(session, capabilitySet);
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
      await emitSessionStart(capabilitySet, "reload");
      return result;
    };
  }

  return { capabilitySet };
}
