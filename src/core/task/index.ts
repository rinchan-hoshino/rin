import type { RinCapabilityDefinition } from "../rin-lib/capability-types.js";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import {
  buildUserFacingTextResult,
  formatToolCallLine,
  renderTextToolResult,
} from "../pi/render-utils.js";
import { requestDaemonCommand } from "../rin-daemon/client.js";

const TASK_CONTROL_COMMANDS = {
  pause: "cron_pause_task",
  resume: "cron_resume_task",
} as const;

type TaskControlAction = keyof typeof TASK_CONTROL_COMMANDS;

type TaskControlParams = {
  action?: unknown;
  taskId?: unknown;
};

type TaskControlResult = {
  action: TaskControlAction;
  taskId: string;
  userText: string;
  task?: unknown;
};

type TaskTheme = {
  fg: (token: string, text: string) => string;
  bold: (text: string) => string;
};

function readTaskId(params: unknown) {
  return String((params as TaskControlParams | undefined)?.taskId || "").trim();
}

function readTaskControlAction(params: unknown): TaskControlAction {
  const action = String(
    (params as TaskControlParams | undefined)?.action || "",
  ).trim();
  if (action === "pause" || action === "resume") return action;
  throw new Error("task_control_action_required: expected pause or resume");
}

function formatTaskControlCall(args: TaskControlParams, theme: TaskTheme) {
  const action = String(args.action || "").trim();
  const taskId = readTaskId(args);
  return formatToolCallLine(
    "task_control",
    [action, taskId].filter(Boolean).join(" ") || "task",
    theme,
    { detailStyle: action ? "accent" : "muted" },
  );
}

function formatTaskLabel(task: any, fallbackId: string) {
  const id = String(task?.id || fallbackId || "").trim();
  const name = String(task?.name || "").trim();
  return name ? `${id} (${name})` : id;
}

function formatTaskControlText(
  action: TaskControlAction,
  taskId: string,
  data: { task?: any },
) {
  const label = formatTaskLabel(data.task, taskId) || taskId;
  return `${action === "pause" ? "Paused" : "Resumed"} task: ${label}`;
}

async function executeTaskControl(params: unknown) {
  const action = readTaskControlAction(params);
  const taskId = readTaskId(params);
  if (!taskId) throw new Error("task_control_taskId_required");
  const data = (await requestDaemonCommand({
    type: TASK_CONTROL_COMMANDS[action],
    taskId,
  })) as { task?: unknown };
  const text = formatTaskControlText(action, taskId, data);
  return {
    content: [{ type: "text" as const, text }],
    details: {
      ...data,
      action,
      taskId,
      userText: text,
    } satisfies TaskControlResult,
  };
}

const taskControlSchema = Type.Object({
  action: Type.Union([Type.Literal("pause"), Type.Literal("resume")], {
    description: "Task control action. Allowed values: `pause` or `resume`.",
  }),
  taskId: Type.String({
    description: "Task id.",
  }),
});

function renderTaskControlResult(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: Partial<TaskControlResult>;
  },
  options: { expanded: boolean; isPartial?: boolean },
  theme: any,
  context: { showImages: boolean },
) {
  const userResult = buildUserFacingTextResult(result, context.showImages, {
    userText: result.details?.userText,
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
        name: "task_control",
        label: "Task Control",
        description: "Pause or resume a scheduled task.",
        promptSnippet: "Pause or resume a scheduled task.",
        promptGuidelines: [],
        parameters: taskControlSchema,
        execute: async (_toolCallId, params) =>
          await executeTaskControl(params),
        renderCall: (args, theme) =>
          new Text(formatTaskControlCall(args, theme), 0, 0),
        renderResult: renderTaskControlResult,
      },
    ],
  };
}
