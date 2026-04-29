#!/usr/bin/env node
import { cac } from "cac";

import { runStart, runStop, runRestart } from "./control.js";
import { runDoctor } from "./doctor.js";
import { launchDefaultRin } from "./launch.js";
import { runGui } from "../rin-gui/main.js";
import { runMemoryIndex, runMemoryIndexInternal } from "./memory-index.js";
import { runStatus, runStatusInternal } from "./status.js";
import {
  hasSubcommandHelpFlag,
  ParsedArgs,
  resolveParsedArgs,
  readRinPackageVersion,
  runUpdate,
  safeString,
} from "./shared.js";
import { runUsage, runUsageInternal } from "./usage.js";

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
  ["gui", "Start the cross-platform Rin GUI shell"],
  ["usage", "Show token telemetry dashboard and grouped usage stats"],
  ["memory-index", "Repair the memory search index from archived transcripts"],
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
    marker: "__status_internal",
    command: "status",
    run: runStatusInternal,
  },
] as const;

function createCli() {
  const cli = cac("rin");
  cli
    .usage(
      "[command] [--beta|--nightly|--git [branch-or-ref]] [options] [-- passthrough]",
    )
    .option("-u, --user <name>", "Run against a specific daemon user")
    .option("--stable", "Use the stable release channel (default)")
    .option("--beta", "Use the beta release channel")
    .option("--nightly", "Use the nightly release channel")
    .option("--git", "Use the git release channel")
    .option("--branch <name>", "Explicit git branch selector")
    .option("--version <value>", "Explicit stable version or git ref selector")
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
    if (hasSubcommandHelpFlag(rawArgv, handler.command)) {
      return { run: handler.run, args: ["--help"] };
    }
  }
  return undefined;
}

export function defaultLaunchModeForPlatform(
  platform: NodeJS.Platform = process.platform,
) {
  return platform === "win32" ? "gui" : "tui";
}

export async function startRinCli() {
  const rawArgv = process.argv.slice(2);
  const internalDispatch = resolveInternalRinDispatch(rawArgv);
  if (internalDispatch) {
    await internalDispatch.run(internalDispatch.args);
    return;
  }

  const cli = createCli();
  const parsedArgv = cli.parse(process.argv, { run: false });
  if (parsedArgv.options.help) {
    cli.outputHelp();
    return;
  }

  const command = parseCommandName(safeString(cli.matchedCommandName).trim());
  const parsed = resolveParsedArgs(command, parsedArgv.options, rawArgv);

  if (parsed.command === "update") return await runUpdate(parsed);
  if (parsed.command === "start") return await runStart(parsed);
  if (parsed.command === "stop") return await runStop(parsed);
  if (parsed.command === "restart") return await runRestart(parsed);
  if (parsed.command === "doctor") return await runDoctor(parsed);
  if (parsed.command === "status")
    return await runStatus(parsed, process.argv.slice(2));
  if (parsed.command === "gui")
    return await runGui(parsed, process.argv.slice(2));
  if (parsed.command === "usage")
    return await runUsage(parsed, process.argv.slice(2));
  if (parsed.command === "memory-index")
    return await runMemoryIndex(parsed, process.argv.slice(2));
  if (parsed.command === "version") {
    console.log(readRinPackageVersion());
    return;
  }

  if (defaultLaunchModeForPlatform() === "gui") {
    await runGui(parsed, process.argv.slice(2));
    return;
  }

  await launchDefaultRin(parsed);
}
