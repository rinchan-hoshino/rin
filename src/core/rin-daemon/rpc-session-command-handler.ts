import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { rawErrorMessage } from "../rin-lib/error-facts.js";
import { fail } from "../rin-lib/rpc.js";
import {
  listBoundSessionPage,
  listBoundSessions,
  renameBoundSession,
} from "../session/factory.js";
import { safeString } from "../text-utils.js";
import {
  rpcDone as done,
  rpcRun as run,
  type RpcCommandRequest,
} from "./rpc-command-handler-context.js";

const THINKING_LEVEL_ORDER = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const sessionSettingsMutationQueues = new WeakMap<object, Promise<unknown>>();

export function getSessionEntries(session: any) {
  return Array.isArray(session?.sessionManager?.getEntries?.())
    ? session.sessionManager.getEntries()
    : [];
}

export function getSessionEntriesSince(session: any, since: unknown) {
  const entries = getSessionEntries(session);
  const cursor = safeString(since).trim();
  if (!cursor) return { entries };
  const index = entries.findIndex((entry: any) => entry?.id === cursor);
  if (index < 0) return { error: `Unknown session entry cursor: ${cursor}` };
  return { entries: entries.slice(index + 1) };
}

export function getSessionLeafId(session: any) {
  return session?.sessionManager?.getLeafId?.() ?? null;
}

export function getSessionTree(session: any) {
  const tree = session?.sessionManager?.getTree?.();
  return Array.isArray(tree) ? tree : [];
}

export function clampSessionThinkingLevel(session: any, level: string) {
  const availableLevels = Array.isArray(session?.getAvailableThinkingLevels?.())
    ? session
        .getAvailableThinkingLevels()
        .map((item: unknown) => safeString(item).trim())
    : [];
  if (availableLevels.includes(level)) return level;
  if (!availableLevels.length) return level;
  const requestedIndex = THINKING_LEVEL_ORDER.indexOf(level);
  if (requestedIndex < 0) return availableLevels[0];
  for (let i = requestedIndex; i < THINKING_LEVEL_ORDER.length; i += 1) {
    if (availableLevels.includes(THINKING_LEVEL_ORDER[i])) {
      return THINKING_LEVEL_ORDER[i];
    }
  }
  for (let i = requestedIndex - 1; i >= 0; i -= 1) {
    if (availableLevels.includes(THINKING_LEVEL_ORDER[i])) {
      return THINKING_LEVEL_ORDER[i];
    }
  }
  return availableLevels[0];
}

export function setSessionThinkingLevel(
  session: any,
  level: string,
  options: { persistSettings?: boolean } = {},
) {
  const requested = safeString(level).trim();
  session.setThinkingLevel(requested || level, {
    persist: options.persistSettings !== false,
  });
  return {
    level:
      safeString(session?.thinkingLevel).trim() ||
      clampSessionThinkingLevel(session, requested),
  };
}

export async function flushSessionSettings(session: any) {
  const settings = session?.settingsManager;
  await settings?.flush?.();
  const errors = settings?.drainErrors?.();
  if (!Array.isArray(errors) || errors.length === 0) return;
  const detail = errors
    .map((item: any) => rawErrorMessage(item?.error ?? item))
    .filter(Boolean)
    .join("; ");
  throw new Error(`rin_settings_write_failed${detail ? `: ${detail}` : ""}`);
}

export async function runPersistedSessionMutation<T>(
  session: any,
  mutate: () => T | Promise<T>,
) {
  const settings = session?.settingsManager;
  if (!settings || typeof settings !== "object") {
    const value = await mutate();
    await flushSessionSettings(session);
    return value;
  }
  const previous = sessionSettingsMutationQueues.get(settings);
  const ready = previous
    ? previous.then(
        () => undefined,
        () => undefined,
      )
    : Promise.resolve();
  const current = ready.then(async () => {
    const value = await mutate();
    await flushSessionSettings(session);
    return value;
  });
  sessionSettingsMutationQueues.set(settings, current);
  try {
    return await current;
  } finally {
    if (sessionSettingsMutationQueues.get(settings) === current) {
      sessionSettingsMutationQueues.delete(settings);
    }
  }
}

export async function setPersistentSessionThinkingLevel(
  session: any,
  level: string,
) {
  return await runPersistedSessionMutation(session, async () => {
    const result = await setSessionThinkingLevel(session, level);
    const effectiveLevel = safeString(
      result?.level || session?.thinkingLevel || level,
    ).trim();
    const settings = session?.settingsManager;
    if (
      effectiveLevel &&
      settings?.getDefaultThinkingLevel?.() !== effectiveLevel
    ) {
      settings?.setDefaultThinkingLevel?.(effectiveLevel);
    }
    return result ?? (effectiveLevel ? { level: effectiveLevel } : undefined);
  });
}

export async function setSessionModel(
  session: any,
  model: any,
  options: { persistSettings?: boolean } = {},
) {
  await session.setModel(model, {
    persist: options.persistSettings !== false,
  });
  return model;
}

export function sessionModelRuntime(session: any) {
  const runtime = session?.modelRuntime || session?.modelRegistry;
  if (!runtime) throw new Error("rin_session_model_runtime_unavailable");
  return runtime;
}

export function sessionAllModels(session: any) {
  const runtime = sessionModelRuntime(session);
  const models =
    typeof runtime.getModels === "function"
      ? runtime.getModels()
      : runtime.getAll?.();
  return Array.isArray(models) ? [...models] : [];
}

export async function sessionAvailableModels(session: any) {
  const models = await sessionModelRuntime(session).getAvailable();
  return Array.isArray(models) ? [...models] : [];
}

export async function resetSessionModelOptionsFromSettings(session: any) {
  if (typeof session?.settingsManager?.reload === "function") {
    await session.settingsManager.reload();
  }

  const provider = safeString(
    session?.settingsManager?.getDefaultProvider?.() ||
      session?.settingsManager?.settings?.defaultProvider,
  ).trim();
  const modelId = safeString(
    session?.settingsManager?.getDefaultModel?.() ||
      session?.settingsManager?.settings?.defaultModel,
  ).trim();
  const thinkingLevel = safeString(
    session?.settingsManager?.getDefaultThinkingLevel?.() ||
      session?.settingsManager?.settings?.defaultThinkingLevel,
  ).trim();

  let model: any;
  if (provider && modelId) {
    const models = await sessionAvailableModels(session);
    model = models.find(
      (item: any) => item?.provider === provider && item?.id === modelId,
    );
    if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
    await setSessionModel(session, model, { persistSettings: false });
  }
  if (thinkingLevel) {
    setSessionThinkingLevel(session, thinkingLevel, { persistSettings: false });
  }
  return {
    model: model || session.model,
    thinkingLevel: session.thinkingLevel,
  };
}

type RpcSessionRuntime = {
  importFromJsonl: (inputPath: unknown) => Promise<{ cancelled?: unknown }>;
  fork: (
    entryId: unknown,
  ) => Promise<{ selectedText?: unknown; cancelled?: unknown }>;
  cwd?: unknown;
  services?: { agentDir?: unknown };
};

export type RpcSessionCommandContext = {
  SessionManager: unknown;
  bindCurrentSession: () => Promise<void>;
  runtime: RpcSessionRuntime;
  getSession: () => AgentSession;
};

export function createRpcSessionCommandHandlers(
  context: RpcSessionCommandContext,
) {
  const { SessionManager, bindCurrentSession, runtime, getSession } = context;
  return {
    async cycle_model({ command, id, type }: RpcCommandRequest) {
      const session = getSession();
      const persistSettings = command.persistSettings !== false;
      const mutate = () =>
        session.cycleModel("forward", { persist: persistSettings });

      return run(
        id,
        type,
        () =>
          persistSettings
            ? runPersistedSessionMutation(session, mutate)
            : mutate(),
        (value) => value ?? null,
      );
    },
    async get_all_models({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return done(id, type, { models: sessionAllModels(session) });
    },
    async get_available_models({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(
        id,
        type,
        () => sessionAvailableModels(session),
        (models) => ({ models }),
      );
    },
    async set_thinking_level({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () => {
        const level = safeString(command.level).trim();
        return command.persistSettings === false
          ? setSessionThinkingLevel(session, level, {
              persistSettings: false,
            })
          : setPersistentSessionThinkingLevel(session, level);
      });
    },
    async reset_model_options_from_settings({
      command,
      id,
      type,
    }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () => resetSessionModelOptionsFromSettings(session));
    },
    async cycle_thinking_level({ command, id, type }: RpcCommandRequest) {
      const session = getSession();
      const persistSettings = command.persistSettings !== false;
      const mutate = () =>
        session.cycleThinkingLevel({ persist: persistSettings });

      return run(
        id,
        type,
        () =>
          persistSettings
            ? runPersistedSessionMutation(session, mutate)
            : mutate(),
        (level) => (level ? { level } : null),
      );
    },
    async get_available_thinking_levels({
      command,
      id,
      type,
    }: RpcCommandRequest) {
      const session = getSession();

      return done(id, type, {
        levels: Array.isArray(session?.getAvailableThinkingLevels?.())
          ? session.getAvailableThinkingLevels()
          : [],
      });
    },
    async set_steering_mode({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () =>
        runPersistedSessionMutation(session, () =>
          session.setSteeringMode(command.mode as "all" | "one-at-a-time"),
        ),
      );
    },
    async set_follow_up_mode({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () =>
        runPersistedSessionMutation(session, () =>
          session.setFollowUpMode(command.mode as "all" | "one-at-a-time"),
        ),
      );
    },
    async compact({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, async () => {
        const value = await session.compact(
          command.customInstructions as string | undefined,
        );
        return value && typeof value === "object" ? value : {};
      });
    },
    async set_auto_compaction({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () =>
        runPersistedSessionMutation(session, () =>
          session.setAutoCompactionEnabled(Boolean(command.enabled)),
        ),
      );
    },
    async set_auto_retry({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () =>
        runPersistedSessionMutation(session, () =>
          session.setAutoRetryEnabled(Boolean(command.enabled)),
        ),
      );
    },
    async abort_retry({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () => session.abortRetry());
    },
    async abort_compaction({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () => session.abortCompaction());
    },
    async bash({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () =>
        session.executeBash(command.command as string, undefined, {
          excludeFromContext: command.excludeFromContext as boolean | undefined,
          id,
        }),
      );
    },
    async abort_bash({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () => session.abortBash());
    },
    async get_session_stats({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return done(id, type, session.getSessionStats());
    },
    async get_session_snapshot({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return done(id, type, {
        entries: getSessionEntries(session),
        leafId: getSessionLeafId(session),
      });
    },
    async get_entries({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      {
        const result = getSessionEntriesSince(session, command.since);
        if (result.error) return fail(id, type, result.error);
        return done(id, type, {
          entries: result.entries,
          leafId: getSessionLeafId(session),
        });
      }
    },
    async get_tree({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return done(id, type, {
        tree: getSessionTree(session),
        leafId: getSessionLeafId(session),
      });
    },
    async set_entry_label({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () =>
        session.sessionManager.appendLabelChange(
          command.entryId as string,
          (command.label as string | undefined)?.trim() || undefined,
        ),
      );
    },
    async navigate_tree({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () =>
        session.navigateTree(command.targetId as string, {
          summarize: command.summarize as boolean | undefined,
          customInstructions: command.customInstructions as string | undefined,
          replaceInstructions: command.replaceInstructions as
            | boolean
            | undefined,
          label: command.label as string | undefined,
        }),
      );
    },
    async export_html({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(
        id,
        type,
        () => session.exportToHtml(command.outputPath as string),
        (path) => ({ path }),
      );
    },
    async export_jsonl({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return done(id, type, {
        path: session.exportToJsonl(command.outputPath as string),
      });
    },
    async import_jsonl({ command, id, type }: RpcCommandRequest) {
      return run(
        id,
        type,
        async () => {
          const value = await runtime.importFromJsonl(command.inputPath);
          await bindCurrentSession();
          return value;
        },
        (value) => ({ cancelled: Boolean(value?.cancelled) }),
      );
    },
    async get_fork_messages({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return done(id, type, {
        messages: session.getUserMessagesForForking(),
      });
    },
    async get_last_assistant_text({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return done(id, type, { text: session.getLastAssistantText() });
    },
    async get_messages({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return done(id, type, { messages: session.messages });
    },
    async append_custom_entry({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      {
        const customType = safeString(command.customType).trim();
        if (!customType) throw new Error("customType is required");
        session.sessionManager?.appendCustomEntry?.(customType, command.data);
        return done(id, type);
      }
    },
    async send_custom_message({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, async () => {
        await session.sendCustomMessage(
          command.message as Parameters<AgentSession["sendCustomMessage"]>[0],
          command.options as Parameters<AgentSession["sendCustomMessage"]>[1],
        );
        return { sent: true };
      });
    },
    async fork({ command, id, type }: RpcCommandRequest) {
      return run(
        id,
        type,
        () =>
          runtime.fork(command.entryId).then(async (value: any) => {
            await bindCurrentSession();
            return value;
          }),
        (value) => ({ text: value.selectedText, cancelled: value.cancelled }),
      );
    },
    async list_sessions({ command, id, type }: RpcCommandRequest) {
      {
        if (command.limit !== undefined || command.offset !== undefined) {
          const currentSession = getSession();
          return done(
            id,
            type,
            await listBoundSessionPage({
              cwd:
                safeString(runtime.cwd).trim() ||
                safeString(currentSession?.sessionManager?.getCwd?.()).trim(),
              agentDir: safeString(runtime.services?.agentDir).trim(),
              limit: command.limit,
              offset: command.offset,
            }),
          );
        }
        const sessions = await listBoundSessions();
        return done(id, type, { sessions });
      }
    },
    async set_model({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      {
        const models = await sessionAvailableModels(session);
        const model = models.find(
          (m: any) =>
            m.provider === command.provider && m.id === command.modelId,
        );
        if (!model)
          throw new Error(
            `Model not found: ${command.provider}/${command.modelId}`,
          );
        const persistSettings = command.persistSettings !== false;
        const mutate = () =>
          setSessionModel(session, model, {
            persistSettings: persistSettings ? undefined : false,
          });
        if (persistSettings) {
          await runPersistedSessionMutation(session, mutate);
        } else {
          await mutate();
        }
        return done(id, type, model);
      }
    },
    async rename_session({ command, id, type }: RpcCommandRequest) {
      {
        await renameBoundSession(
          command as Parameters<typeof renameBoundSession>[0],
          command.name as string,
          {
            SessionManager,
          },
        );
        return done(id, type);
      }
    },
    async set_session_name({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      {
        const name = String(command.name || "").trim();
        if (!name) throw new Error("Session name cannot be empty");
        session.setSessionName(name);
        return done(id, type);
      }
    },
  };
}

export type RpcSessionCommandHandlers = ReturnType<
  typeof createRpcSessionCommandHandlers
>;
