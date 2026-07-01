#!/usr/bin/env node
import { printRunHelp, shouldRunNonInteractive } from "./run-lite.js";
import {
  hasSubcommandHelpFlag,
  type ParsedArgs,
  readRinPackageVersion,
  resolveParsedArgs,
  safeString,
  stripRinWrapperArgs,
} from "./shared-lite.js";

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

type InternalCommandRunner = (args: string[]) => void | Promise<void>;

const INTERNAL_COMMANDS = [
  {
    marker: "__usage_internal",
    command: "usage",
    loadRun: async () => (await import("./usage.js")).runUsageInternal,
  },
  {
    marker: "__memory_index_internal",
    command: "memory-index",
    loadRun: async () =>
      (await import("./memory-index.js")).runMemoryIndexInternal,
  },
  {
    marker: "__self_improve_internal",
    command: "self-improve",
    loadRun: async () =>
      (await import("./self-improve.js")).runSelfImproveInternal,
  },
  {
    marker: "__status_internal",
    command: "status",
    loadRun: async () => (await import("./status.js")).runStatusInternal,
  },
  {
    marker: "__tasks_internal",
    command: "tasks",
    loadRun: async () => (await import("./tasks.js")).runTasksInternal,
  },
  {
    marker: "__docs_internal",
    command: "",
    loadRun: async () => (await import("./docs.js")).runDocsInternal,
  },
] as const;

type CacOptionForHelp = {
  rawName?: string;
  config?: { default?: unknown };
};

type CacCliForHelp = {
  globalCommand?: { options?: CacOptionForHelp[] };
};

function hideCacNegatedDefaultFromHelp(cli: CacCliForHelp, optionName: string) {
  const option = cli.globalCommand?.options?.find((candidate) =>
    safeString(candidate.rawName).includes(optionName),
  );
  if (option?.config) option.config.default = undefined;
}

async function createCli() {
  const { cac } = await import("cac");
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
    .option("--timeout <seconds>", "Maximum wait time for non-interactive mode")
    .help();

  // CAC treats --no-* flags as negated positive booleans and injects
  // default:true into help. Rin parses these tool flags from raw argv in
  // run.ts/Pi, so the top-level help must not claim tools are disabled by
  // default.
  hideCacNegatedDefaultFromHelp(cli, "--no-tools");
  hideCacNegatedDefaultFromHelp(cli, "--no-builtin-tools");

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

function lazyInternalRun(
  loadRun: () => Promise<InternalCommandRunner>,
): InternalCommandRunner {
  return async (args) => {
    const run = await loadRun();
    return await run(args);
  };
}

export function resolveInternalRinDispatch(rawArgv: string[]) {
  for (const handler of INTERNAL_COMMANDS) {
    if (rawArgv[0] === handler.marker) {
      return { run: lazyInternalRun(handler.loadRun), args: rawArgv.slice(1) };
    }
    if (handler.command && hasSubcommandHelpFlag(rawArgv, handler.command)) {
      return { run: lazyInternalRun(handler.loadRun), args: ["--help"] };
    }
  }
  return undefined;
}

export function defaultLaunchModeForPlatform(
  _platform: NodeJS.Platform = process.platform,
) {
  return "tui";
}

function hasExplicitTargetArg(rawArgv: string[]) {
  return rawArgv.some(
    (arg) => arg === "--target" || arg.startsWith("--target="),
  );
}

function isLocalVersionFastPath(rawArgv: string[]) {
  if (hasExplicitTargetArg(rawArgv)) return false;
  const args = stripRinWrapperArgs(rawArgv);
  return args.length === 1 && args[0] === "version";
}

export async function startRinCli() {
  const rawArgv = process.argv.slice(2);
  if (isLocalVersionFastPath(rawArgv)) {
    console.log(readRinPackageVersion());
    return;
  }

  const internalDispatch = resolveInternalRinDispatch(rawArgv);
  if (internalDispatch) {
    await internalDispatch.run(internalDispatch.args);
    return;
  }

  if (
    rawArgv.some((arg) => arg === "--help" || arg === "-h") &&
    shouldRunNonInteractive(rawArgv, true)
  ) {
    printRunHelp();
    return;
  }

  const cli = await createCli();
  const parsedArgv = cli.parse(process.argv, { run: false });
  if (parsedArgv.options.help) {
    cli.outputHelp();
    return;
  }

  const command = parseCommandName(safeString(cli.matchedCommandName).trim());
  const parsed = resolveParsedArgs(command, parsedArgv.options, rawArgv);

  if (!command && shouldRunNonInteractive(rawArgv)) {
    const { runNonInteractive } = await import("./run.js");
    return await runNonInteractive(parsed, rawArgv);
  }

  if (parsed.command === "target") {
    const { runTargetCommand } = await import("./targets.js");
    return await runTargetCommand(rawArgv);
  }
  if (parsed.explicitTarget) {
    const { resolveTargetForName, runRinOnTarget } =
      await import("../rin-targets/runner.js");
    const target = resolveTargetForName(parsed.targetName);
    if (!target) throw new Error(`rin_target_not_found:${parsed.targetName}`);
    const status = runRinOnTarget(target, rawArgv);
    process.exitCode = status;
    return;
  }

  if (parsed.command === "update") {
    const { runUpdate } = await import("./shared.js");
    return await runUpdate(parsed);
  }
  if (parsed.command === "start") {
    const { runStart } = await import("./control.js");
    return await runStart(parsed);
  }
  if (parsed.command === "stop") {
    const { runStop } = await import("./control.js");
    return await runStop(parsed);
  }
  if (parsed.command === "restart") {
    const { runRestart } = await import("./control.js");
    return await runRestart(parsed);
  }
  if (parsed.command === "doctor") {
    const { runDoctor } = await import("./doctor.js");
    return await runDoctor(parsed, process.argv.slice(2));
  }
  if (parsed.command === "status") {
    const { runStatus } = await import("./status.js");
    return await runStatus(parsed, process.argv.slice(2));
  }
  if (parsed.command === "tasks") {
    const { runTasks } = await import("./tasks.js");
    return await runTasks(parsed, process.argv.slice(2));
  }
  if (parsed.command === "usage") {
    const { runUsage } = await import("./usage.js");
    return await runUsage(parsed, process.argv.slice(2));
  }
  if (parsed.command === "self-improve") {
    const { runSelfImprove } = await import("./self-improve.js");
    return await runSelfImprove(parsed, process.argv.slice(2));
  }
  if (parsed.command === "versions") {
    const { runVersions } = await import("./versions.js");
    return runVersions(parsed);
  }
  if (parsed.command === "rollback") {
    const { runRollback } = await import("./versions.js");
    return await runRollback(parsed);
  }
  if (parsed.command === "memory-index") {
    const { runMemoryIndex } = await import("./memory-index.js");
    return await runMemoryIndex(parsed, process.argv.slice(2));
  }
  if (parsed.command === "version") {
    console.log(readRinPackageVersion());
    return;
  }

  const { launchDefaultRin } = await import("./launch.js");
  await launchDefaultRin(parsed);
}
