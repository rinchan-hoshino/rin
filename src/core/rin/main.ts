#!/usr/bin/env node
import { cac } from "cac";

import { runStart, runStop, runRestart } from "./control.js";
import { runDocsInternal } from "./docs.js";
import { runDoctor } from "./doctor.js";
import { launchDefaultRin } from "./launch.js";
import { runMemoryIndex, runMemoryIndexInternal } from "./memory-index.js";
import { runNonInteractive, shouldRunNonInteractive } from "./run.js";
import { runStatus, runStatusInternal } from "./status.js";
import { runTasks, runTasksInternal } from "./tasks.js";
import {
  hasSubcommandHelpFlag,
  ParsedArgs,
  resolveParsedArgs,
  readRinPackageVersion,
  runUpdate,
  safeString,
} from "./shared.js";
import { runUsage, runUsageInternal } from "./usage.js";
import { runSelfImprove, runSelfImproveInternal } from "./self-improve.js";
import { runRollback, runVersions } from "./versions.js";
import { runTargetCommand } from "./targets.js";
import { resolveTargetForName, runRinOnTarget } from "../rin-targets/runner.js";

const RIN_COMMANDS = [
  [
    "update",
    "Update the installed Rin core runtime for the target user (does not update the CLI launcher)",
  ],
  ["start", "Start the target user daemon"],
  ["stop", "Stop the target user daemon"],
  ["restart", "Restart the target user daemon"],
  ["doctor", "Show daemon/socket diagnostics for the target user"],
  ["status", "Show live worker and scheduled task activity"],
  ["tasks", "Operate scheduled task records"],
  ["usage", "Show subscription/API usage status and backend usage reports"],
  ["self-improve", "Show recent self-improve outcomes and backend history"],
  ["versions", "List installed Rin runtime versions"],
  ["rollback", "Rollback the installed Rin runtime to the previous version"],
  ["memory-index", "Repair the recall index from archived transcripts"],
  ["target", "List, select, and inspect configured Rin deployment targets"],
  ["version", "Show Rin version"],
] as const satisfies ReadonlyArray<readonly [ParsedArgs["command"], string]>;

const INTERNAL_COMMANDS = [
  {
    marker: "__usage_internal",
    command: "usage",
    run: runUsageInternal,
  },
  {
    marker: "__memory_index_internal",
    command: "memory-index",
    run: runMemoryIndexInternal,
  },
  {
    marker: "__self_improve_internal",
    command: "self-improve",
    run: runSelfImproveInternal,
  },
  {
    marker: "__status_internal",
    command: "status",
    run: runStatusInternal,
  },
  {
    marker: "__tasks_internal",
    command: "tasks",
    run: runTasksInternal,
  },
  {
    marker: "__docs_internal",
    command: "",
    run: runDocsInternal,
  },
] as const;

function createCli() {
  const cli = cac("rin");
  cli
    .usage(
      "[command] [--beta|--nightly|--git [branch-or-ref]] [options] [-- passthrough]",
    )
    .option("-u, --user <name>", "Run against a specific daemon user")
    .option("--target <name>", "Run against a configured Rin deployment target")
    .option("--stable", "Use the stable release channel")
    .option("--beta", "Use the beta release channel")
    .option("--nightly", "Use the nightly release channel")
    .option("--git", "Use the git release channel")
    .option("--branch <name>", "Explicit git branch selector")
    .option("--version <value>", "Explicit stable version or git ref selector")
    .option("--yes", "Update mode: run without confirmation prompts")
    .option("-p, --print", "Non-interactive mode: process prompt and exit")
    .option("--mode <mode>", "Output mode: text (default) or json")
    .option("--provider <name>", "Provider name for non-interactive mode")
    .option("--model <provider/model>", "Model for non-interactive mode")
    .option("--thinking <level>", "Thinking level for non-interactive mode")
    .option(
      "--managed-session <leaf>",
      "Create and keep a non-interactive session under sessions/managed/<leaf>/",
    )
    .option("--name <name>", "Session display name for non-interactive mode")
    .option("-t, --tools <tools>", "Tool allowlist for non-interactive mode")
    .option(
      "-xt, --exclude-tools <tools>",
      "Tool denylist for non-interactive mode",
    )
    .option("-nt, --no-tools", "Disable all tools in non-interactive mode")
    .option(
      "-nbt, --no-builtin-tools",
      "Disable built-in tools in non-interactive mode",
    )
    .help();

  for (const [name, description] of RIN_COMMANDS) {
    cli.command(name, description);
  }

  return cli;
}

function parseCommandName(name: string): ParsedArgs["command"] {
  return RIN_COMMANDS.some(([command]) => command === name)
    ? (name as ParsedArgs["command"])
    : "";
}

export function resolveInternalRinDispatch(rawArgv: string[]) {
  for (const handler of INTERNAL_COMMANDS) {
    if (rawArgv[0] === handler.marker) {
      return { run: handler.run, args: rawArgv.slice(1) };
    }
    if (handler.command && hasSubcommandHelpFlag(rawArgv, handler.command)) {
      return { run: handler.run, args: ["--help"] };
    }
  }
  return undefined;
}

export function defaultLaunchModeForPlatform(
  _platform: NodeJS.Platform = process.platform,
) {
  return "tui";
}

export async function startRinCli() {
  const rawArgv = process.argv.slice(2);
  const internalDispatch = resolveInternalRinDispatch(rawArgv);
  if (internalDispatch) {
    await internalDispatch.run(internalDispatch.args);
    return;
  }

  if (
    rawArgv.some((arg) => arg === "--help" || arg === "-h") &&
    shouldRunNonInteractive(rawArgv, true)
  ) {
    await runNonInteractive(resolveParsedArgs("", {}, rawArgv), rawArgv);
    return;
  }

  const cli = createCli();
  const parsedArgv = cli.parse(process.argv, { run: false });
  const command = parseCommandName(safeString(cli.matchedCommandName).trim());
  const parsed = resolveParsedArgs(command, parsedArgv.options, rawArgv);
  if (parsedArgv.options.help) {
    cli.outputHelp();
    return;
  }

  if (!command && shouldRunNonInteractive(rawArgv)) {
    return await runNonInteractive(parsed, rawArgv);
  }

  if (parsed.command === "target") return await runTargetCommand(rawArgv);
  if (parsed.explicitTarget) {
    const target = resolveTargetForName(parsed.targetName);
    if (!target) throw new Error(`rin_target_not_found:${parsed.targetName}`);
    const status = runRinOnTarget(target, rawArgv);
    process.exitCode = status;
    return;
  }

  if (parsed.command === "update") return await runUpdate(parsed);
  if (parsed.command === "start") return await runStart(parsed);
  if (parsed.command === "stop") return await runStop(parsed);
  if (parsed.command === "restart") return await runRestart(parsed);
  if (parsed.command === "doctor")
    return await runDoctor(parsed, process.argv.slice(2));
  if (parsed.command === "status")
    return await runStatus(parsed, process.argv.slice(2));
  if (parsed.command === "tasks")
    return await runTasks(parsed, process.argv.slice(2));
  if (parsed.command === "usage")
    return await runUsage(parsed, process.argv.slice(2));
  if (parsed.command === "self-improve")
    return await runSelfImprove(parsed, process.argv.slice(2));
  if (parsed.command === "versions") return runVersions(parsed);
  if (parsed.command === "rollback") return await runRollback(parsed);
  if (parsed.command === "memory-index")
    return await runMemoryIndex(parsed, process.argv.slice(2));
  if (parsed.command === "version") {
    console.log(readRinPackageVersion());
    return;
  }

  await launchDefaultRin(parsed);
}
