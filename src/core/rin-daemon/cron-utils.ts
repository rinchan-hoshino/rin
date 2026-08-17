import path from "node:path";

import { Cron } from "croner";

import { schedulerDataPath } from "../data-layout.js";

import { safeString } from "../platform/process.js";
export { nowIso } from "../time-utils.js";

import type { CronTaskRecord, CronTaskTrigger } from "./cron-contract.js";

function normalizeCronText(
  value: unknown,
  options: { stripCarriageReturns?: boolean } = {},
) {
  const text = safeString(value);
  return (options.stripCarriageReturns ? text.replace(/\r/g, "") : text).trim();
}

function invalidCronExpression(): never {
  throw new Error("cron_invalid_expression");
}

function parseFiveFieldCron(expression: string) {
  const text = safeString(expression).trim();
  if (text.split(/\s+/).length !== 5) invalidCronExpression();
  try {
    return new Cron(text, { paused: true });
  } catch {
    return invalidCronExpression();
  }
}

function shouldStopTask(task: CronTaskRecord, referenceTs: number) {
  if (task.completedAt || !task.enabled) return true;
  if (task.termination?.maxRuns && task.runCount >= task.termination.maxRuns) {
    return true;
  }
  if (!task.termination?.stopAt) return false;
  const stopTs = Date.parse(task.termination.stopAt);
  return Number.isFinite(stopTs) && referenceTs > stopTs;
}

function computeOnceNextRunAt(trigger: CronTaskTrigger, referenceTs: number) {
  const runTs = Date.parse(trigger.runAt);
  if (!Number.isFinite(runTs) || runTs <= referenceTs) {
    return undefined;
  }
  return new Date(runTs).toISOString();
}

export function normalizeIso(value: unknown, field: string) {
  const text = normalizeCronText(value);
  if (!text) return undefined;
  const ts = Date.parse(text);
  if (!Number.isFinite(ts)) throw new Error(`cron_invalid_${field}`);
  return new Date(ts).toISOString();
}

export function cronRoot(agentDir: string) {
  return schedulerDataPath(agentDir);
}

export function cronTasksPath(agentDir: string) {
  return path.join(cronRoot(agentDir), "tasks.json");
}

export function createCronTaskId() {
  return `cron_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function cronTaskRunId(
  task: Pick<CronTaskRecord, "id" | "runCount" | "lastStartedAt">,
  startedAt = task.lastStartedAt,
) {
  const stableStartedAt = safeString(startedAt).trim();
  if (!stableStartedAt) throw new Error("cron_tasks_file_invalid");
  return `${task.id}:${task.runCount}:${stableStartedAt}`;
}

export function summarizeText(value: string, max = 1200) {
  const text = normalizeCronText(value, { stripCarriageReturns: true });
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function nextCronAt(expression: string, afterTs: number) {
  const next = parseFiveFieldCron(expression).nextRun(new Date(afterTs));
  if (!next) throw new Error("cron_next_run_not_found");
  return next.toISOString();
}

export function computeNextRunAt(task: CronTaskRecord, referenceTs: number) {
  if (shouldStopTask(task, referenceTs)) return undefined;

  if (task.trigger.expression) {
    return nextCronAt(task.trigger.expression, referenceTs);
  }

  return computeOnceNextRunAt(task.trigger, referenceTs);
}
