import type {
  RpcCommandRequest,
  RpcDone,
  RpcRun,
} from "./rpc-command-handler-context.js";

export type RpcSessionCommandContext = {
  runPersistedSessionMutation: (...args: any[]) => any;
  sessionAllModels: (...args: any[]) => any;
  sessionAvailableModels: (...args: any[]) => any;
  setSessionThinkingLevel: (...args: any[]) => any;
  setPersistentSessionThinkingLevel: (...args: any[]) => any;
  resetSessionModelOptionsFromSettings: (...args: any[]) => any;
  getSessionEntries: (...args: any[]) => any;
  getSessionLeafId: (...args: any[]) => any;
  getSessionEntriesSince: (...args: any[]) => any;
  fail: (...args: any[]) => any;
  getSessionTree: (...args: any[]) => any;
  SessionManager: any;
  bindCurrentSession: (...args: any[]) => any;
  listBoundSessionPage: (...args: any[]) => any;
  safeString: (...args: any[]) => any;
  listBoundSessions: (...args: any[]) => any;
  setSessionModel: (...args: any[]) => any;
  renameBoundSession: (...args: any[]) => any;
  runtime: any;
  getSession: () => any;
  done: RpcDone;
  run: RpcRun;
};

export function createRpcSessionCommandHandlers(
  context: RpcSessionCommandContext,
) {
  const {
    runPersistedSessionMutation,
    sessionAllModels,
    sessionAvailableModels,
    setSessionThinkingLevel,
    setPersistentSessionThinkingLevel,
    resetSessionModelOptionsFromSettings,
    getSessionEntries,
    getSessionLeafId,
    getSessionEntriesSince,
    fail,
    getSessionTree,
    SessionManager,
    bindCurrentSession,
    listBoundSessionPage,
    safeString,
    listBoundSessions,
    setSessionModel,
    renameBoundSession,
    runtime,
    getSession,
    done,
    run,
  } = context;
  return {
    async cycle_model({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(
        id,
        type,
        () => runPersistedSessionMutation(session, () => session.cycleModel()),
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

      return run(
        id,
        type,
        () =>
          runPersistedSessionMutation(session, () =>
            session.cycleThinkingLevel(),
          ),
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
          session.setSteeringMode(command.mode),
        ),
      );
    },
    async set_follow_up_mode({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () =>
        runPersistedSessionMutation(session, () =>
          session.setFollowUpMode(command.mode),
        ),
      );
    },
    async compact({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, async () => {
        const value = await session.compact(command.customInstructions);
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
        session.executeBash(command.command, undefined, {
          excludeFromContext: command.excludeFromContext,
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
          command.entryId,
          command.label?.trim() || undefined,
        ),
      );
    },
    async navigate_tree({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(id, type, () =>
        session.navigateTree(command.targetId, {
          summarize: command.summarize,
          customInstructions: command.customInstructions,
          replaceInstructions: command.replaceInstructions,
          label: command.label,
        }),
      );
    },
    async export_html({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return run(
        id,
        type,
        () => session.exportToHtml(command.outputPath),
        (path) => ({ path }),
      );
    },
    async export_jsonl({ command, id, type }: RpcCommandRequest) {
      const session = getSession();

      return done(id, type, {
        path: session.exportToJsonl(command.outputPath),
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
        await session.sendCustomMessage(command.message, command.options);
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
        await renameBoundSession(command, command.name, {
          SessionManager,
        });
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
