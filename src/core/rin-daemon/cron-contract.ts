import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import type { RinFrontendIdentity } from "../rin-lib/frontend-identity.js";
import type {
  ScheduledTaskSessionMode,
  ScheduledTaskTargetKind,
} from "../scheduled-task-options.js";

export type CronTaskTarget =
  | {
      kind: Extract<ScheduledTaskTargetKind, "agent_prompt">;
      prompt?: string;
      continuationPrompt?: string;
    }
  | {
      kind: Extract<ScheduledTaskTargetKind, "shell_command">;
      command: string;
      timeoutMs?: number;
    };

export type CronTaskTrigger = {
  startAt?: string;
  expression?: string;
  timezone?: "local";
  runAt?: string;
};

export type CronTaskTermination = {
  maxRuns?: number;
  stopAt?: string;
};

export type CronTaskCondition = {
  code: string;
  timeoutMs?: number;
  lastEvaluatedAt?: string;
  lastResult?: boolean;
  lastOutput?: string;
};

export type CronTaskSessionBinding = {
  mode: ScheduledTaskSessionMode;
};

export type CronTaskFrontendBinding = {
  kind?: string;
  key: string;
};

export type CronTaskThinkingLevel = ThinkingLevel;

export type CronSessionInvocation = {
  id: string;
  requestTag: string;
  taskId: string;
  runCount: number;
  startedAt: string;
  scheduledNextRunAt?: string;
  sessionFile: string;
  continuing?: boolean;
  name?: string;
  frontend?: CronTaskFrontendBinding;
  quiet?: boolean;
  model?: string;
  thinkingLevel?: CronTaskThinkingLevel;
  disabledRinCapabilities?: string[];
  session: CronTaskSessionBinding;
  target: Extract<CronTaskTarget, { kind: "agent_prompt" }>;
  promptMeta: Record<string, unknown> & { sentAt: number };
  retryAttempt?: number;
  nextAttemptAt?: string;
};

export type CronTaskRecord = {
  id: string;
  createdAt: string;
  updatedAt: string;
  createdFrom?: {
    sessionFile?: string;
    sessionId?: string;
    sessionName?: string;
    frontend?: RinFrontendIdentity;
  };
  name?: string;
  enabled: boolean;
  completedAt?: string;
  completionReason?: string;
  pausedAt?: string;
  frontend?: CronTaskFrontendBinding;
  quiet?: boolean;
  model?: string;
  thinkingLevel?: CronTaskThinkingLevel;
  disabledRinCapabilities?: string[];
  trigger: CronTaskTrigger;
  termination?: CronTaskTermination;
  condition?: CronTaskCondition;
  session: CronTaskSessionBinding;
  target: CronTaskTarget;
  dedicatedSessionFile?: string;
  dedicatedSessionPersistent?: boolean;
  nextRunAt?: string;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastResultText?: string;
  lastError?: string;
  runCount: number;
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
  model?: string;
  thinkingLevel?: CronTaskThinkingLevel;
  disabledRinCapabilities?: string[] | null;
  trigger?: CronTaskTrigger;
  termination?: CronTaskTermination | null;
  condition?: CronTaskCondition | null;
  session?: CronTaskSessionBinding;
  target?: CronTaskTarget;
};
