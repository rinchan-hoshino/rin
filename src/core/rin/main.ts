#!/usr/bin/env node
import { printRunHelp, shouldRunNonInteractive } from "./run-lite.js";
import {
  hasSubcommandHelpFlag,
  type ParsedArgs,
  readRinPackageVersion,
  resolveParsedArgs,
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

const RIN_UPDATE_ROUTE_FLAGS = new Set([
  "-u",
  "--user",
  "--target",
  "--stable",
  "--beta",
  "--nightly",
  "--git",
  "--branch",
  "--version",
  "--yes",
]);

export function isExplicitRinUpdateInvocation(rawArgv: string[]) {
  if (stripRinWrapperArgs(rawArgv)[0] !== "update") return false;
  return rawArgv.some((arg) => {
    const flag = arg.split("=", 1)[0];
    return RIN_UPDATE_ROUTE_FLAGS.has(flag);
  });
}

function parseRinWrapperOptions(rawArgv: string[]) {
  const options: Record<string, string> = {};
  for (let index = 0; index < rawArgv.length; index += 1) {
    const arg = rawArgv[index];
    if (arg === "-u" || arg === "--user" || arg === "--target") {
      const value = rawArgv[index + 1];
      if (value && !value.startsWith("-")) {
        options[arg === "--target" ? "target" : "user"] = value;
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--user=")) options.user = arg.slice("--user=".length);
    if (arg.startsWith("--target=")) {
      options.target = arg.slice("--target=".length);
    }
  }
  return options;
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

  const strippedArgv = stripRinWrapperArgs(rawArgv);
  const isPiUpdateHelp =
    strippedArgv[0] === "update" &&
    strippedArgv.some((arg) => arg === "--help" || arg === "-h");
  const internalDispatch = isPiUpdateHelp
    ? null
    : resolveInternalRinDispatch(rawArgv);
  if (internalDispatch) {
    await internalDispatch.run(internalDispatch.args);
    return;
  }

  const { tryRunPiCliCommand } = await import("./pi-command-adapter.js");
  const piRoute = isExplicitRinUpdateInvocation(rawArgv)
    ? "rin"
    : await tryRunPiCliCommand(strippedArgv);
  if (piRoute === "handled") return;
  if (piRoute === "rin-after-pi") {
    const parsed = resolveParsedArgs(
      "update",
      parseRinWrapperOptions(rawArgv),
      ["update"],
    );
    const { runUpdate } = await import("./shared.js");
    return await runUpdate(parsed);
  }

  const extensionCommandAdapter =
    await import("./extension-command-adapter.js");
  const runtimeModule = await import("../rin-lib/runtime.js");
  const loaderModule = await import("../rin-lib/loader.js");
  const profileModule = await import("../rin-lib/profile.js");
  const extensionCommandDependencies = {
    resolveProfile: profileModule.resolveRuntimeProfile,
    loadSessionManager: loaderModule.loadRinSessionManagerModule,
    createSession: runtimeModule.createConfiguredAgentSession,
  };
  if (
    await extensionCommandAdapter.tryRunExtensionCommandCli({
      argv: strippedArgv,
      stdout: process.stdout,
      stderr: process.stderr,
      dependencies: extensionCommandDependencies,
    })
  ) {
    return;
  }

  const command = parseCommandName(strippedArgv[0] || "");
  if (!command) {
    if (
      strippedArgv.length === 1 &&
      (strippedArgv[0] === "--help" || strippedArgv[0] === "-h")
    ) {
      const { printRinCliHelp } = await import("./pi-command-adapter.js");
      const extensionCommands =
        await extensionCommandAdapter.listExtensionCliCommands({
          dependencies: extensionCommandDependencies,
        });
      printRinCliHelp(RIN_COMMANDS, extensionCommands);
      return;
    }
    if (
      rawArgv.some((arg) => arg === "--help" || arg === "-h") &&
      shouldRunNonInteractive(rawArgv, true)
    ) {
      printRunHelp();
      return;
    }
  }

  let parsedOptions = parseRinWrapperOptions(rawArgv);
  if (command) {
    const rinCommandArgv =
      command === "update"
        ? rawArgv.filter(
            (arg, index) =>
              !(
                index > 0 &&
                (arg === "self" ||
                  arg === "pi" ||
                  arg === "--self" ||
                  arg === "--force")
              ),
          )
        : rawArgv;
    const cli = await createCli();
    const parsedArgv = cli.parse(
      [process.argv[0], process.argv[1], ...rinCommandArgv],
      { run: false },
    );
    if (parsedArgv.options.help) {
      cli.outputHelp();
      return;
    }
    parsedOptions = parsedArgv.options;
  }
  const parsed = resolveParsedArgs(command, parsedOptions, rawArgv);

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
