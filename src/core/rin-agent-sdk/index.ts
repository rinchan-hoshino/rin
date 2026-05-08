import { requestDaemonCommand } from "../rin-daemon/client.js";

export type RinAgentSdkOptions = {
  socketPath?: string;
  timeoutMs?: number;
};

export type TaskControlAction = "pause" | "resume";

export type ChatRunTurnOptions = {
  chatKey?: string;
  text: string;
  sessionFile?: string;
  sessionId?: string;
  managedSessionLeaf?: string;
  model?: string;
  thinkingLevel?: string;
  controllerKey?: string;
  deliveryEnabled?: boolean;
  affectChatBinding?: boolean;
  disposeAfterTurn?: boolean;
  promptMeta?: unknown;
};

export type ChatSendOptions = {
  chatKey: string;
  text?: string;
  parts?: unknown[];
  [key: string]: unknown;
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
    tasks: {
      list: async (override?: RinAgentSdkOptions) =>
        await request<{ tasks: unknown[] }>(
          { type: "cron_list_tasks" },
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
      run: async (taskId: string, override?: RinAgentSdkOptions) =>
        await request<{ task?: unknown }>(
          { type: "cron_run_task", taskId: trimTaskId(taskId) },
          override,
        ),
      control: controlTask,
    },
    chat: {
      send: async (payload: ChatSendOptions, override?: RinAgentSdkOptions) =>
        await request<{ delivered?: boolean }>(
          { type: "chat_send", payload },
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
      terminateTurn: async (
        controllerKey: string,
        override?: RinAgentSdkOptions,
      ) =>
        await request<{ terminated: boolean }>(
          { type: "chat_terminate_turn", payload: { controllerKey } },
          override,
        ),
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
