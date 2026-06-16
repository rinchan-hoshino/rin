import path from "node:path";

import {
  canConnectDaemonSocket,
  requestDaemonCommand,
} from "../rin-daemon/client.js";
import { isJsonRecord } from "../json-utils.js";
import { formatReportTime } from "./report-format.js";
import {
  captureInternalRinCommand,
  createTargetExecutionContext,
  extractSubcommandArgv,
  ParsedArgs,
  safeString,
} from "./shared.js";

export type TasksCliOptions = {
  action: "reload" | "";
  json: boolean;
  help: boolean;
};

function printTasksHelp() {
  console.log(
    [
      "rin tasks <command> [options]",
      "",
      "Commands:",
      "  reload       reload scheduled task records from ~/.rin/data/scheduler/tasks.json into the running daemon",
      "",
      "Options:",
      "  --json       print the raw reload result",
      "  --help       show this help",
      "",
      "Examples:",
      "  rin tasks reload",
      "  rin tasks reload --json",
    ].join("\n"),
  );
}

export function parseTasksArgs(argv: string[]): TasksCliOptions {
  const args = extractSubcommandArgv(argv, "tasks");
  const result: TasksCliOptions = {
    action: "",
    json: false,
    help: false,
  };
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg === "reload") {
      if (result.action) throw new Error(`unknown_tasks_arg:${arg}`);
      result.action = "reload";
      continue;
    }
    throw new Error(`unknown_tasks_arg:${arg}`);
  }
  if (!result.help && !result.action) result.help = true;
  return result;
}

function formatTasksUnavailable(options: Pick<TasksCliOptions, "json">) {
  return options.json
    ? JSON.stringify({ error: "rin_daemon_unavailable" })
    : "Rin daemon is unavailable.";
}

function formatReloadResult(result: unknown) {
  const cron = isJsonRecord(result) ? result.cron : undefined;
  const value = isJsonRecord(cron) ? cron : {};
  const taskCount = safeString(value.taskCount ?? "0").trim() || "0";
  const enabledTaskCount =
    safeString(value.enabledTaskCount ?? "0").trim() || "0";
  const nextRunAt = formatReportTime(value.nextRunAt);
  return `Scheduled tasks reloaded: ${taskCount} tasks, ${enabledTaskCount} enabled, next ${nextRunAt}`;
}

async function runReload(options: TasksCliOptions, socketPath?: string) {
  const result = await requestDaemonCommand(
    { id: "tasks_reload_1", type: "cron_reload_tasks" },
    { socketPath, timeoutMs: 30_000 },
  );
  return options.json ? JSON.stringify(result) : formatReloadResult(result);
}

export async function runTasksInternal(rawArgv: string[]) {
  const options = parseTasksArgs(rawArgv);
  if (options.help) {
    printTasksHelp();
    return;
  }
  if (!(await canConnectDaemonSocket(undefined, 500))) {
    console.log(formatTasksUnavailable(options));
    return;
  }
  console.log(await runReload(options));
}

export async function runTasks(parsed: ParsedArgs, rawArgv: string[]) {
  const options = parseTasksArgs(rawArgv);
  if (options.help) {
    printTasksHelp();
    return;
  }
  const context = createTargetExecutionContext(parsed);
  if (!context.isTargetUser) {
    const forwarded = captureInternalRinCommand(
      context,
      "__tasks_internal",
      rawArgv,
      "tasks",
    );
    process.stdout.write(forwarded);
    return;
  }
  if (!(await context.canConnectSocket())) {
    console.log(formatTasksUnavailable(options));
    return;
  }
  console.log(await runReload(options, context.socketPath));
}
