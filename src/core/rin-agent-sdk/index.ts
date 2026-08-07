import { requestDaemonCommand } from "../rin-daemon/client.js";
import type { ChatMessageRead } from "../chat/message-query.js";
import type { RinFrontendIdentity } from "../rin-frontend-sdk/frontend-identity.js";
import type { RinToolStartupOptions } from "../rin-lib/tool-options.js";

export type RinAgentSdkOptions = {
  socketPath?: string;
  timeoutMs?: number;
};

export type TaskControlAction = "pause" | "resume";

export type SessionListOptions = {
  limit?: number;
  offset?: number;
};

export type ChatRunTurnOptions = RinToolStartupOptions & {
  chatKey?: string;
  frontend?: RinFrontendIdentity;
  text: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  managedSessionLeaf?: string;
  model?: string;
  thinkingLevel?: string;
  controllerKey?: string;
  affectChatBinding?: boolean;
  linkDeliveriesToSession?: boolean;
  disposeAfterTurn?: boolean;
  shutdownAfterTurn?: boolean;
  deliverFinal?: boolean;
  quietMode?: boolean;
  promptMeta?: unknown;
};

export type ChatSendOptions = {
  chatKey: string;
  text?: string;
  parts?: unknown[];
  [key: string]: unknown;
};

export type ChatTypingOptions =
  | string
  | {
      chatKey: string;
    };

export type ChatReactOptions = {
  chatKey: string;
  messageId: string;
  emoji: string;
};

export type ChatTerminateTurnOptions =
  | string
  | {
      controllerKey?: string;
      chatKey?: string;
    };

export type ChatMessageGetOptions = {
  chatKey: string;
  messageId: string;
};

export type ChatMessageListOptions = {
  chatKey: string;
  before?: string;
  after?: string;
  limit?: number;
};

export type ChatBridgeEvalOptions = {
  code: string;
  currentChatKey?: string;
  requestId?: string;
  timeoutMs?: number;
  sessionFile?: string;
  sessionId?: string;
};

function mergeOptions(
  base: RinAgentSdkOptions,
  override?: RinAgentSdkOptions,
): RinAgentSdkOptions {
  return {
    socketPath: override?.socketPath ?? base.socketPath,
    timeoutMs: override?.timeoutMs ?? base.timeoutMs,
  };
}

function trimTaskId(taskId: string) {
  const id = String(taskId || "").trim();
  if (!id) throw new Error("rin_agent_sdk_task_id_required");
  return id;
}

function commandOptions(options: RinAgentSdkOptions) {
  return {
    socketPath: options.socketPath,
    timeoutMs: options.timeoutMs,
  };
}

function normalizeChatSendOptions(payload: ChatSendOptions) {
  const { text, parts, ...rest } = payload;
  return {
    ...rest,
    parts: Array.isArray(parts)
      ? parts
      : [{ type: "text", text: String(text ?? "") }],
  };
}

function normalizeChatMessageGetOptions(payload: ChatMessageGetOptions) {
  const chatKey = String(payload?.chatKey || "").trim();
  const messageId = String(payload?.messageId || "").trim();
  if (!chatKey) throw new Error("chat_message_store_chatKey_required");
  if (!messageId) throw new Error("chat_message_store_messageId_required");
  return { chatKey, messageId };
}

function normalizeChatMessageListOptions(payload: ChatMessageListOptions) {
  const chatKey = String(payload?.chatKey || "").trim();
  if (!chatKey) throw new Error("chat_message_store_chatKey_required");
  const before = String(payload?.before || "").trim();
  const after = String(payload?.after || "").trim();
  const requestedLimit = Number(payload?.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(100, Math.trunc(requestedLimit)))
    : 20;
  return {
    chatKey,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    limit,
  };
}

export function createRinAgentSdk(options: RinAgentSdkOptions = {}) {
  const request = async <T = unknown>(
    command: Record<string, unknown>,
    override?: RinAgentSdkOptions,
  ): Promise<T> =>
    (await requestDaemonCommand(
      command,
      commandOptions(mergeOptions(options, override)),
    )) as T;

  const controlTask = async (
    action: TaskControlAction,
    taskId: string,
    override?: RinAgentSdkOptions,
  ) =>
    await request<{ task?: unknown }>(
      {
        type: action === "pause" ? "cron_pause_task" : "cron_resume_task",
        taskId: trimTaskId(taskId),
      },
      override,
    );

  return {
    daemon: {
      status: async (override?: RinAgentSdkOptions) =>
        await request({ type: "daemon_status" }, override),
      activity: async (override?: RinAgentSdkOptions) =>
        await request({ type: "daemon_activity" }, override),
    },
    sessions: {
      list: async (
        options: SessionListOptions = {},
        override?: RinAgentSdkOptions,
      ) =>
        await request(
          {
            type: "list_sessions",
            limit: options.limit,
            offset: options.offset,
          },
          override,
        ),
    },
    tasks: {
      list: async (override?: RinAgentSdkOptions) =>
        await request<{ tasks: unknown[] }>(
          { type: "cron_list_tasks" },
          override,
        ),
      reload: async (override?: RinAgentSdkOptions) =>
        await request<{ cron: unknown }>(
          { type: "cron_reload_tasks" },
          override,
        ),
      get: async (taskId: string, override?: RinAgentSdkOptions) =>
        await request<{ task?: unknown }>(
          { type: "cron_get_task", taskId: trimTaskId(taskId) },
          override,
        ),
      upsert: async (
        task: Record<string, unknown>,
        defaults: Record<string, unknown> = {},
        override?: RinAgentSdkOptions,
      ) =>
        await request<{ task?: unknown }>(
          { type: "cron_upsert_task", task, defaults },
          override,
        ),
      delete: async (taskId: string, override?: RinAgentSdkOptions) =>
        await request<{ deleted: boolean }>(
          { type: "cron_delete_task", taskId: trimTaskId(taskId) },
          override,
        ),
      complete: async (
        taskId: string,
        reason = "completed_by_sdk",
        override?: RinAgentSdkOptions,
      ) =>
        await request<{ task?: unknown }>(
          { type: "cron_complete_task", taskId: trimTaskId(taskId), reason },
          override,
        ),
      pause: async (taskId: string, override?: RinAgentSdkOptions) =>
        await controlTask("pause", taskId, override),
      resume: async (taskId: string, override?: RinAgentSdkOptions) =>
        await controlTask("resume", taskId, override),
      rescheduleOnce: async (
        taskId: string,
        runAt: string,
        override?: RinAgentSdkOptions,
      ) =>
        await request<{ task?: unknown }>(
          {
            type: "cron_reschedule_once_task",
            taskId: trimTaskId(taskId),
            runAt,
          },
          override,
        ),
      run: async (taskId: string, override?: RinAgentSdkOptions) =>
        await request<{ task?: unknown }>(
          { type: "cron_run_task", taskId: trimTaskId(taskId) },
          override,
        ),
      wake: async (taskId: string, override?: RinAgentSdkOptions) =>
        await request<{ task?: unknown }>(
          { type: "cron_wake_task", taskId: trimTaskId(taskId) },
          override,
        ),
      control: controlTask,
    },
    chat: {
      send: async (payload: ChatSendOptions, override?: RinAgentSdkOptions) =>
        await request<{ delivered?: boolean }>(
          { type: "chat_send", payload: normalizeChatSendOptions(payload) },
          override,
        ),
      runTurn: async (
        payload: ChatRunTurnOptions,
        override?: RinAgentSdkOptions,
      ) =>
        await request<Record<string, unknown>>(
          { type: "chat_run_turn", payload },
          override,
        ),
      typing: async (
        target: ChatTypingOptions,
        override?: RinAgentSdkOptions,
      ) => {
        const chatKey =
          typeof target === "string"
            ? target.trim()
            : String(target.chatKey || "").trim();
        return await request<{ sent?: boolean }>(
          { type: "chat_typing", payload: { chatKey } },
          override,
        );
      },
      react: async (payload: ChatReactOptions, override?: RinAgentSdkOptions) =>
        await request<{ sent?: boolean }>(
          { type: "chat_react", payload },
          override,
        ),
      terminateTurn: async (
        target: ChatTerminateTurnOptions,
        override?: RinAgentSdkOptions,
      ) =>
        await request<{
          terminated: boolean;
          chatKey?: string;
          controllerKey?: string;
        }>(
          {
            type: "chat_terminate_turn",
            payload:
              typeof target === "string" ? { controllerKey: target } : target,
          },
          override,
        ),
      messages: {
        get: async (
          payload: ChatMessageGetOptions,
          override?: RinAgentSdkOptions,
        ) =>
          await request<ChatMessageRead | null>(
            {
              type: "chat_message_get",
              payload: normalizeChatMessageGetOptions(payload),
            },
            override,
          ),
        list: async (
          payload: ChatMessageListOptions,
          override?: RinAgentSdkOptions,
        ) =>
          await request<ChatMessageRead[]>(
            {
              type: "chat_message_list",
              payload: normalizeChatMessageListOptions(payload),
            },
            override,
          ),
      },
      evalBridge: async (
        payload: ChatBridgeEvalOptions,
        override?: RinAgentSdkOptions,
      ) =>
        await request<Record<string, unknown>>(
          { type: "chat_bridge_eval", payload },
          override,
        ),
    },
  };
}

export type RinAgentSdk = ReturnType<typeof createRinAgentSdk>;

export const rinAgentSdk = createRinAgentSdk();
