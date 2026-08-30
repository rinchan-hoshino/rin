export const SCHEDULED_TASK_TARGET_KINDS = [
  "agent_prompt",
  "shell_command",
] as const;

export const SCHEDULED_TASK_MANAGE_ACTIONS = [
  "delete",
  "pause",
  "resume",
] as const;

export type ScheduledTaskTargetKind =
  (typeof SCHEDULED_TASK_TARGET_KINDS)[number];
export type ScheduledTaskManageAction =
  (typeof SCHEDULED_TASK_MANAGE_ACTIONS)[number];
