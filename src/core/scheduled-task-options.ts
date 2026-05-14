export const SCHEDULED_TASK_TARGET_KINDS = [
  "agent_prompt",
  "shell_command",
] as const;

export const SCHEDULED_TASK_SESSION_MODES = [
  "none",
  "dedicated",
  "session_instruction",
] as const;

export const SCHEDULED_TASK_MANAGE_ACTIONS = [
  "delete",
  "pause",
  "resume",
] as const;

export const DEFAULT_SCHEDULED_TASK_SESSION_MODE = "none";

export type ScheduledTaskTargetKind =
  (typeof SCHEDULED_TASK_TARGET_KINDS)[number];

export type ScheduledTaskSessionMode =
  (typeof SCHEDULED_TASK_SESSION_MODES)[number];

export type ScheduledTaskManageAction =
  (typeof SCHEDULED_TASK_MANAGE_ACTIONS)[number];

export function normalizeScheduledTaskSessionMode(
  value: unknown,
): ScheduledTaskSessionMode | undefined {
  const text = String(value || "").trim();
  return SCHEDULED_TASK_SESSION_MODES.includes(text as ScheduledTaskSessionMode)
    ? (text as ScheduledTaskSessionMode)
    : undefined;
}

export function isScheduledTaskSessionMode(
  value: unknown,
): value is ScheduledTaskSessionMode {
  return Boolean(normalizeScheduledTaskSessionMode(value));
}
