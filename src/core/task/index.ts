import type { RinCapabilityDefinition } from "../rin-lib/capability-types.js";
import { type TruncationResult } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import { normalizeChatKey } from "../chat/support.js";
import { ALL_THINKING_LEVELS } from "../model-thinking-levels.js";
import {
  buildUserFacingTextResult,
  prepareTruncatedAgentUserText,
  renderTextToolResult,
} from "../pi/render-utils.js";
import { requestDaemonCommand } from "../rin-daemon/client.js";
import { createCronTaskId } from "../rin-daemon/cron-utils.js";
import type { CronTaskInput, CronTaskRecord } from "../rin-daemon/cron.js";
import {
  DEFAULT_SCHEDULED_TASK_SESSION_MODE,
  SCHEDULED_TASK_MANAGE_ACTIONS,
  SCHEDULED_TASK_SESSION_MODES,
  SCHEDULED_TASK_TARGET_KINDS,
  type ScheduledTaskManageAction,
} from "../scheduled-task-options.js";
import { readSessionMetadata } from "../session/metadata.js";

const NO_SCHEDULED_TASKS_TEXT = "No scheduled tasks.";
const TASK_MUTATION_COMMANDS = {
  delete: "cron_delete_task",
  pause: "cron_pause_task",
  resume: "cron_resume_task",
} as const satisfies Record<ScheduledTaskManageAction, string>;

type TaskAction = "get" | "save" | ScheduledTaskManageAction;
type TaskRecordLike = Partial<CronTaskRecord>;
type TaskCommandResponse = {
  task?: TaskRecordLike;
  tasks?: TaskRecordLike[];
  deleted?: boolean;
  [key: string]: unknown;
};
type TaskToolTexts = {
  agentText: string;
  userText: string;
};
type TaskTheme = {
  fg: (token: string, text: string) => string;
  bold: (text: string) => string;
};
type TaskRenderOptions = Parameters<typeof renderTextToolResult>[1];
type TaskRenderTheme = Parameters<typeof renderTextToolResult>[2];
type TaskRenderResult = Parameters<typeof renderTextToolResult>[0];
type TaskGetParams = {
  taskId?: unknown;
};
type TaskManageParams = {
  action?: unknown;
  taskId?: unknown;
};
type TaskSaveCallArgs = {
  name?: unknown;
  trigger?: Record<string, unknown> | null;
  target?: { kind?: unknown } | null;
};

type TaskSaveDefaults = {
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  chatKey?: string;
};

function wrapAgentPrompt(prompt: string) {
  return String(prompt || "").trim();
}

const createLooseEnumSchema = (...args: Parameters<typeof StringEnum>) =>
  StringEnum(...args) as any;

function formatAllowedValues(
  values: readonly string[],
  options = { quote: true },
) {
  return values
    .map((value) => (options.quote ? `\`${value}\`` : value))
    .join(", ");
}

function allowedValuesDescription(
  prefix: string,
  values: readonly string[],
  options = { quote: true },
) {
  return `${prefix} Allowed values: ${formatAllowedValues(values, options)}.`;
}

function readTaskSaveDefaults(ctx: unknown): TaskSaveDefaults {
  const session = readSessionMetadata(ctx);
  const sessionName = session.sessionName || undefined;
  return {
    sessionFile: session.sessionFile || undefined,
    sessionId: session.sessionId || undefined,
    sessionName,
    chatKey: normalizeChatKey(sessionName),
  };
}

function buildTaskTarget(target: CronTaskInput["target"]) {
  if (target?.kind === "agent_prompt") {
    return {
      kind: "agent_prompt" as const,
      prompt: wrapAgentPrompt(String(target.prompt || "")) || undefined,
      continuationPrompt:
        wrapAgentPrompt(String((target as any).continuationPrompt || "")) ||
        undefined,
    };
  }
  if (target) {
    return {
      kind: "shell_command" as const,
      command: String(target.command || ""),
    };
  }
  return undefined;
}

function buildTaskForSave(input: CronTaskInput, defaults: TaskSaveDefaults) {
  const taskId = String(input.id || "").trim() || createCronTaskId();
  const session = input.session ?? {
    mode: DEFAULT_SCHEDULED_TASK_SESSION_MODE,
  };
  const chatKey =
    input.chatKey !== undefined ? input.chatKey : defaults.chatKey;
  return {
    ...input,
    id: taskId,
    chatKey,
    session,
    target: buildTaskTarget(input.target),
  };
}

function renderTaskLabel(task: TaskRecordLike) {
  const id = String(task.id || "").trim();
  const name = String(task.name || "").trim();
  return name ? `${id} (${name})` : id;
}

function renderTaskTrigger(trigger: TaskRecordLike["trigger"]) {
  if (trigger?.intervalMs) {
    return `every ${String(trigger.intervalMs || 0)}ms`;
  }
  if (trigger?.expression) {
    return `cron ${String(trigger.expression || "")}`;
  }
  return `once ${String(trigger?.runAt || "")}`;
}

function renderTaskTarget(target: TaskRecordLike["target"]) {
  if (target?.kind === "shell_command") {
    return `command: ${String(target.command || "")}`;
  }
  return `agent: ${String(target?.prompt || "")}`;
}

function renderTaskSession(task: TaskRecordLike) {
  const sessionFile = task.dedicatedSessionFile
    ? String(task.dedicatedSessionFile)
    : "";
  const options = [
    task.model ? `model=${String(task.model)}` : "",
    task.thinkingLevel ? `thinking=${String(task.thinkingLevel)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `session=${String(task.session?.mode || "")}${sessionFile ? `:${sessionFile}` : ""}${options ? ` ${options}` : ""}`;
}

function renderTaskState(task: TaskRecordLike) {
  if (task.completedAt) return `completed=${String(task.completedAt)}`;
  if (task.enabled === false) return "disabled";
  return `next=${String(task.nextRunAt || "pending")}`;
}

function renderTask(task: TaskRecordLike) {
  return [
    renderTaskLabel(task),
    renderTaskTrigger(task.trigger),
    renderTaskTarget(task.target),
    task.chatKey ? `chat=${String(task.chatKey)}` : "",
    renderTaskSession(task),
    renderTaskState(task),
  ]
    .filter(Boolean)
    .join("\n");
}

function renderTaskList(tasks: TaskRecordLike[]) {
  if (!tasks.length) return NO_SCHEDULED_TASKS_TEXT;
  return tasks.map((task) => renderTask(task)).join("\n\n");
}

function formatTaskLabel(task: TaskRecordLike) {
  return renderTaskLabel(task) || "unnamed_task";
}

function readTaskId(params: unknown) {
  return String(
    (params as TaskGetParams | TaskManageParams | null | undefined)?.taskId ||
      "",
  ).trim();
}

function readManageTaskAction(params: unknown) {
  return String(
    (params as TaskManageParams | null | undefined)?.action || "",
  ).trim();
}

function buildFallbackTexts(
  action: Exclude<TaskAction, "get" | "save">,
  data: TaskCommandResponse,
  params: unknown,
): TaskToolTexts {
  const deletedText = `Deleted task: ${readTaskId(params)}`;
  const renderedTask = data.task ? renderTask(data.task) : "";
  return {
    agentText:
      renderedTask || (data.deleted ? deletedText : `scheduled_task ${action}`),
    userText:
      renderedTask ||
      (data.deleted ? deletedText : JSON.stringify(data, null, 2)),
  };
}

function buildTexts(
  action: TaskAction,
  data: TaskCommandResponse,
  params: unknown,
): TaskToolTexts {
  if (action === "get") {
    const text = data.task
      ? renderTask(data.task)
      : renderTaskList(Array.isArray(data.tasks) ? data.tasks : []);
    return { agentText: text, userText: text };
  }

  if (action === "save" && data.task) {
    const text = `Saved task: ${formatTaskLabel(data.task)}`;
    return { agentText: text, userText: text };
  }

  return buildFallbackTexts(
    action as Exclude<TaskAction, "get" | "save">,
    data,
    params,
  );
}

const taskSchema = Type.Object({
  id: Type.Optional(
    Type.String({
      description:
        "Existing task id to update in place. Omit to create a new task.",
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "Human-friendly task name." }),
  ),
  enabled: Type.Optional(
    Type.Boolean({
      description: "Whether the task should remain enabled after saving.",
    }),
  ),
  chatKey: Type.Optional(
    Type.Union([
      Type.String({
        description:
          "Explicit bound chat like telegram/123456:987654321 or onebot/123456:private:12345.",
      }),
      Type.Null(),
    ]),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Optional model override for agent_prompt tasks, in provider/model form such as openai-codex/gpt-5.5.",
    }),
  ),
  thinkingLevel: Type.Optional(
    createLooseEnumSchema(ALL_THINKING_LEVELS, {
      description: allowedValuesDescription(
        "Optional thinking level override for agent_prompt tasks.",
        ALL_THINKING_LEVELS,
        { quote: false },
      ),
    }),
  ),
  trigger: Type.Object({
    intervalMs: Type.Optional(
      Type.Number({
        description:
          "For interval tasks. The interval is measured from task start time.",
      }),
    ),
    startAt: Type.Optional(
      Type.String({
        description: "Optional ISO timestamp for the first interval run.",
      }),
    ),
    expression: Type.Optional(
      Type.String({
        description: "Standard 5-field cron expression in local time.",
      }),
    ),
    runAt: Type.Optional(
      Type.String({
        description:
          "ISO timestamp for a one-time scheduled run. Used when intervalMs and expression are omitted.",
      }),
    ),
  }),
  termination: Type.Optional(
    Type.Union([
      Type.Object({
        maxRuns: Type.Optional(
          Type.Number({ description: "Stop after this many runs." }),
        ),
        stopAt: Type.Optional(
          Type.String({
            description: "ISO timestamp after which the task should stop.",
          }),
        ),
      }),
      Type.Null(),
    ]),
  ),
  session: Type.Optional(
    Type.Object({
      mode: createLooseEnumSchema(SCHEDULED_TASK_SESSION_MODES, {
        description:
          "Session mode. Use `none` for the default no-session task; use `dedicated` to create and reuse the task-id-named session across runs.",
      }),
    }),
  ),
  target: Type.Object({
    kind: createLooseEnumSchema(SCHEDULED_TASK_TARGET_KINDS, {
      description: allowedValuesDescription(
        "Task target kind.",
        SCHEDULED_TASK_TARGET_KINDS,
      ),
    }),
    prompt: Type.Optional(
      Type.String({
        description:
          "Instruction for scheduled agent execution. For dedicated-session tasks, this is the first-turn instruction.",
      }),
    ),
    continuationPrompt: Type.Optional(
      Type.String({
        description:
          "Instruction used when a dedicated task session continues after the first turn.",
      }),
    ),
    command: Type.Optional(
      Type.String({ description: "Shell command for direct execution." }),
    ),
  }),
});

const getTaskSchema = Type.Object({
  taskId: Type.Optional(
    Type.String({
      description: "Task id. Omit it to list scheduled tasks instead.",
    }),
  ),
});

const manageTaskSchema = Type.Object({
  action: createLooseEnumSchema(SCHEDULED_TASK_MANAGE_ACTIONS, {
    description: allowedValuesDescription(
      "Task action.",
      SCHEDULED_TASK_MANAGE_ACTIONS,
    ),
  }),
  taskId: Type.String({
    description: "Task id.",
  }),
});

type TaskActionDetails = {
  action: TaskAction;
  userText?: string;
  fullOutputPath?: string;
  truncated?: boolean;
  truncation?: TruncationResult;
};

function formatListTaskResult(
  result: TaskRenderResult,
  options: TaskRenderOptions,
  theme: TaskRenderTheme,
  showImages: boolean,
) {
  return renderTextToolResult(result, options, theme, showImages, {
    truncation: result.details?.truncation as TruncationResult | undefined,
  });
}

function isTaskMutationAction(
  action: string,
): action is ScheduledTaskManageAction {
  return Object.prototype.hasOwnProperty.call(TASK_MUTATION_COMMANDS, action);
}

async function executeTaskAction(
  action: TaskAction,
  params: unknown,
  ctx: unknown,
) {
  const defaults = readTaskSaveDefaults(ctx);

  let data: TaskCommandResponse;
  if (action === "get") {
    const taskId = readTaskId(params);
    data = (await requestDaemonCommand(
      taskId ? { type: "cron_get_task", taskId } : { type: "cron_list_tasks" },
    )) as TaskCommandResponse;
  } else if (action === "save") {
    data = (await requestDaemonCommand({
      type: "cron_upsert_task",
      task: buildTaskForSave((params || {}) as CronTaskInput, defaults),
      defaults,
    })) as TaskCommandResponse;
  } else if (isTaskMutationAction(action)) {
    data = (await requestDaemonCommand({
      type: TASK_MUTATION_COMMANDS[action],
      taskId: readTaskId(params),
    })) as TaskCommandResponse;
  } else {
    throw new Error(`Unsupported action: ${action}`);
  }

  const texts = buildTexts(action, data, params);
  if (action === "get") {
    const truncated = prepareTruncatedAgentUserText(
      texts.agentText,
      texts.userText,
    );
    return {
      content: [{ type: "text" as const, text: truncated.outputText }],
      details: {
        ...data,
        action,
        userText: truncated.userPreviewText,
        truncation: truncated.userTruncation,
      } satisfies TaskActionDetails,
    };
  }

  return {
    content: [{ type: "text" as const, text: texts.agentText }],
    details: {
      ...data,
      action,
      userText: texts.userText,
      truncation: undefined,
    } satisfies TaskActionDetails,
  };
}

function formatGetTaskCall(args: TaskGetParams, theme: TaskTheme) {
  const taskId = readTaskId(args);
  return [
    theme.fg("toolTitle", theme.bold("get_task")),
    taskId ? ` ${theme.fg("accent", taskId)}` : "",
  ].join("");
}

function formatSaveTaskCall(args: TaskSaveCallArgs, theme: TaskTheme) {
  const name = String(args.name || "").trim();
  const trigger = String(args.trigger?.kind || "").trim();
  const target = String(args.target?.kind || "").trim();
  const parts = [
    theme.fg("toolTitle", theme.bold("save_task")),
    name ? ` ${theme.fg("accent", name)}` : "",
    trigger ? theme.fg("muted", ` ${trigger}`) : "",
    target ? theme.fg("muted", ` ${target}`) : "",
  ];
  return parts.join("");
}

function formatManageTaskCall(args: TaskManageParams, theme: TaskTheme) {
  const action = readManageTaskAction(args);
  const taskId = readTaskId(args);
  return [
    theme.fg("toolTitle", theme.bold("manage_task")),
    action ? ` ${theme.fg("muted", action)}` : "",
    taskId ? ` ${theme.fg("accent", taskId)}` : "",
  ].join("");
}

function renderTaskResult(
  result: TaskRenderResult,
  options: TaskRenderOptions,
  theme: TaskRenderTheme,
  context: { showImages: boolean },
) {
  const details = result.details as TaskActionDetails | undefined;
  if (details?.action === "get") {
    return new Text(
      formatListTaskResult(result, options, theme, context.showImages),
      0,
      0,
    );
  }
  const userResult = buildUserFacingTextResult(result, context.showImages, {
    userText: details?.userText,
  });
  return new Text(
    renderTextToolResult(userResult, options, theme, context.showImages),
    0,
    0,
  );
}

export default function cronModule(): RinCapabilityDefinition {
  return {
    name: "task",
    tools: [
      {
        name: "get_task",
        label: "Get Task",
        description:
          "Get a specific scheduled task, or list scheduled tasks when taskId is omitted.",
        promptSnippet:
          "Get a specific scheduled task, or list scheduled tasks.",
        promptGuidelines: [],
        parameters: getTaskSchema,
        execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
          await executeTaskAction("get", params, ctx),
        renderCall: (args, theme) =>
          new Text(formatGetTaskCall(args, theme), 0, 0),
        renderResult: renderTaskResult,
      },
      {
        name: "save_task",
        label: "Save Task",
        description: "Create or update a scheduled task.",
        promptSnippet: "Create or update a scheduled task.",
        promptGuidelines: [
          "When save_task sets the chatKey field, the agent's final message is sent to that chat automatically, so the scheduled prompt should focus only on generating the final output and should not repeat delivery instructions.",
        ],
        parameters: taskSchema,
        execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
          await executeTaskAction("save", params, ctx),
        renderCall: (args, theme) =>
          new Text(formatSaveTaskCall(args, theme), 0, 0),
        renderResult: renderTaskResult,
      },
      {
        name: "manage_task",
        label: "Manage Task",
        description: "Delete, pause, or resume a scheduled task.",
        promptSnippet: "Delete, pause, or resume a scheduled task.",
        promptGuidelines: [],
        parameters: manageTaskSchema,
        execute: async (_toolCallId, params, _signal, _onUpdate, ctx) =>
          await executeTaskAction(
            readManageTaskAction(params) as TaskAction,
            params,
            ctx,
          ),
        renderCall: (args, theme) =>
          new Text(formatManageTaskCall(args, theme), 0, 0),
        renderResult: renderTaskResult,
      },
    ],
  };
}
