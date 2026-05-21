import path from "node:path";

import { safeString } from "../platform/process.js";
export { nowIso } from "../time-utils.js";

import type { CronTaskRecord, CronTaskTrigger } from "./cron.js";

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

function parseCronChunk(chunk: string, min: number, max: number) {
  const [rangePart, stepPart] = chunk.split("/");
  const step = stepPart == null ? 1 : Number(stepPart);
  if (!Number.isInteger(step) || step <= 0) invalidCronExpression();

  if (rangePart === "*") {
    return { start: min, end: max, step };
  }

  const rangeMatch = rangePart.match(/^(\d+)(?:-(\d+))?$/);
  if (!rangeMatch) invalidCronExpression();

  const start = Number(rangeMatch[1]);
  const end = rangeMatch[2] == null ? start : Number(rangeMatch[2]);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < min ||
    end > max ||
    start > end
  ) {
    invalidCronExpression();
  }

  return { start, end, step };
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

function computeOnceNextRunAt(
  trigger: CronTaskTrigger,
  runCount: number,
  referenceTs: number,
) {
  const runTs = Date.parse(trigger.runAt);
  if (!Number.isFinite(runTs) || runTs <= referenceTs || runCount > 0) {
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
  return path.join(path.resolve(agentDir), "data", "cron");
}

export function cronTasksPath(agentDir: string) {
  return path.join(cronRoot(agentDir), "tasks.json");
}

export function createCronTaskId() {
  return `cron_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function cronTaskRunId(task: CronTaskRecord) {
  return `${task.id}:${task.runCount}:${Date.now()}`;
}

export function summarizeText(value: string, max = 1200) {
  const text = normalizeCronText(value, { stripCarriageReturns: true });
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function formatCronField(field: string, min: number, max: number) {
  const chunks = safeString(field)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!chunks.length) invalidCronExpression();

  const allowed = new Set<number>();
  for (const chunk of chunks) {
    const { start, end, step } = parseCronChunk(chunk, min, max);
    for (let value = start; value <= end; value += step) allowed.add(value);
  }
  return allowed;
}

export function nextCronAt(expression: string, afterTs: number) {
  const parts = safeString(expression).trim().split(/\s+/);
  if (parts.length !== 5) invalidCronExpression();
  const [minuteField, hourField, dayField, monthField, weekField] = parts;
  const minutes = formatCronField(minuteField, 0, 59);
  const hours = formatCronField(hourField, 0, 23);
  const days = formatCronField(dayField, 1, 31);
  const months = formatCronField(monthField, 1, 12);
  const weeks = formatCronField(weekField, 0, 6);

  const start = new Date(afterTs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60 * 2; i += 1) {
    const candidate = new Date(start.getTime() + i * 60_000);
    if (!minutes.has(candidate.getMinutes())) continue;
    if (!hours.has(candidate.getHours())) continue;
    if (!days.has(candidate.getDate())) continue;
    if (!months.has(candidate.getMonth() + 1)) continue;
    if (!weeks.has(candidate.getDay())) continue;
    return candidate.toISOString();
  }

  throw new Error("cron_next_run_not_found");
}

export function computeNextRunAt(task: CronTaskRecord, referenceTs: number) {
  if (shouldStopTask(task, referenceTs)) return undefined;

  if (task.trigger.expression) {
    return nextCronAt(task.trigger.expression, referenceTs);
  }

  return computeOnceNextRunAt(task.trigger, task.runCount, referenceTs);
}
