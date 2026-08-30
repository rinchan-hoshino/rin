import type { RinFrontendIdentity } from "../rin-lib/frontend-identity.js";
import type { PromptContextMeta } from "../rin-lib/prompt-context.js";
import type { ScheduledTaskTargetKind } from "../scheduled-task-options.js";

export type CronTaskTrigger = {
  startAt?: string;
  expression?: string;
  timezone?: "local";
  runAt?: string;
};

export type CronTaskCondition = {
  code: string;
  timeoutMs?: number;
  lastEvaluatedAt?: string;
  lastResult?: boolean;
  lastOutput?: string;
};

export type CronTaskTarget =
  | {
      kind: Extract<ScheduledTaskTargetKind, "agent_prompt">;
      prompt: string;
      continuationPrompt?: string;
    }
  | {
      kind: Extract<ScheduledTaskTargetKind, "shell_command">;
      command: string;
      timeoutMs?: number;
    };

export type CronTaskTermination = {
  maxRuns?: number;
  stopAt?: string;
};

export type CronTaskFrontendBinding = {
  kind?: string;
  key?: string;
};

export type CronSessionInvocation = {
  id: string;
  requestTag: string;
  taskId: string;
  runCount: number;
  startedAt: string;
  scheduledNextRunAt?: string;
  continuing?: boolean;
  name?: string;
  frontend?: CronTaskFrontendBinding;
  quiet?: boolean;
  target: Extract<CronTaskTarget, { kind: "agent_prompt" }>;
  promptMeta: PromptContextMeta & { sentAt: number };
  retryAttempt?: number;
  nextAttemptAt?: string;
};

export type CronTaskRecord = {
  id: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  createdFrom?: {
    sessionFile?: string;
    sessionId?: string;
    sessionName?: string;
    chatKey?: string;
    frontend?: RinFrontendIdentity;
  };
  enabled: boolean;
  completedAt?: string;
  completionReason?: string;
  pausedAt?: string;
  frontend?: CronTaskFrontendBinding;
  quiet?: boolean;
  trigger: CronTaskTrigger;
  termination?: CronTaskTermination;
  condition?: CronTaskCondition;
  target: CronTaskTarget;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastResultText?: string;
  lastError?: string;
  runCount: number;
  nextRunAt?: string;
  running: boolean;
  activeStartedAt?: string;
  activeDurationMs?: number;
  activeInvocation?: CronSessionInvocation;
};

export type CronTaskInput = {
  id?: string;
  name?: string;
  enabled?: boolean;
  frontend?: CronTaskFrontendBinding | null;
  quiet?: boolean;
  trigger?: CronTaskTrigger;
  termination?: CronTaskTermination | null;
  condition?: CronTaskCondition | null;
  target?: CronTaskTarget;
};
