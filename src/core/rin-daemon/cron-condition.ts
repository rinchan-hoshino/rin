import { spawnSync } from "node:child_process";

import { safeString } from "../platform/process.js";

import type { CronTaskCondition, CronTaskRecord } from "./cron-contract.js";

export type CronConditionEvaluation = {
  passed: boolean;
  output?: string;
};

function normalizeTimeoutMs(value: unknown) {
  const timeoutMs = Number(value);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 5_000;
  return Math.min(60_000, Math.max(100, Math.round(timeoutMs)));
}

export function evaluateCronTaskCondition(
  condition: CronTaskCondition | undefined,
  task: CronTaskRecord,
): CronConditionEvaluation {
  if (!condition?.code) return { passed: true };
  const context = {
    now: new Date().toISOString(),
    task: {
      id: task.id,
      name: task.name,
      runCount: task.runCount,
      lastStartedAt: task.lastStartedAt,
      lastFinishedAt: task.lastFinishedAt,
      lastResultText: task.lastResultText,
      lastError: task.lastError,
      nextRunAt: task.nextRunAt,
    },
  };
  const runner = `
const input = JSON.parse(await new Promise((resolve) => {
  let body = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { body += chunk; });
  process.stdin.on("end", () => resolve(body));
}));
const { stripTypeScriptTypes } = await import("node:module");
const rawCode = String(input.code || "");
const context = input.context || {};
let result;
if (/^\\s*(?:async\\s+)?(?:function\\b|\\(?[\\w\\s,{}[\\].:=]*\\)?\\s*=>)/.test(rawCode)) {
  const code = stripTypeScriptTypes(rawCode);
  result = await (0, eval)("(" + code + ")")(context);
} else if (/\\breturn\\b/.test(rawCode)) {
  const code = stripTypeScriptTypes(
    "globalThis.__condition__ = async (context) => {\\n" + rawCode + "\\n};",
  );
  (0, eval)(code);
  result = await globalThis.__condition__(context);
} else {
  const code = stripTypeScriptTypes(
    "globalThis.__condition__ = async (context) => (" + rawCode + ");",
  );
  (0, eval)(code);
  result = await globalThis.__condition__(context);
}
process.stdout.write(JSON.stringify({ passed: Boolean(result), result }));
`;
  const child = spawnSync(
    process.execPath,
    ["--no-warnings=ExperimentalWarning", "--input-type=module", "-e", runner],
    {
      input: JSON.stringify({ code: condition.code, context }),
      encoding: "utf8",
      timeout: normalizeTimeoutMs(condition.timeoutMs),
      maxBuffer: 1024 * 1024,
    },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `cron_condition_failed:${safeString(child.stderr || child.stdout).trim()}`,
    );
  }
  const output = safeString(child.stdout).trim();
  const parsed = JSON.parse(output || "{}");
  return { passed: Boolean(parsed.passed), output };
}
