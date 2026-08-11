import { register } from "node:module";

const replacements: Record<string, string> = {
  "dist/core/rin/run-lite.js": `
    export function shouldRunNonInteractive(argv) {
      return argv.includes("-p") || argv.includes("--print");
    }
    export function printRunHelp() {
      globalThis.__rinMainOwnerEvents.push(["print-help"]);
    }
  `,
  "dist/core/rin/shared-lite.js": `
    const commands = new Set(["update","start","stop","restart","doctor","status","tasks","self-improve","versions","rollback","memory-index","target","version"]);
    export function hasSubcommandHelpFlag(argv, command) {
      const index = argv.indexOf(command);
      return index >= 0 && argv.slice(index + 1).some((value) => value === "--help" || value === "-h");
    }
    export function readRinPackageVersion() { return "9.8.7-owner"; }
    export function safeString(value) { return value == null ? "" : String(value); }
    export function stripRinWrapperArgs(argv) {
      const result = [];
      for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (value === "--target" || value === "--user" || value === "-u") { index += 1; continue; }
        if (value === "--maint") continue;
        if (value.startsWith("--target=") || value.startsWith("--user=")) continue;
        result.push(value);
      }
      return result;
    }
    export function resolveParsedArgs(command, options, rawArgv) {
      const targetIndex = rawArgv.indexOf("--target");
      const targetValue = rawArgv.find((value) => value.startsWith("--target="));
      const targetName = targetValue ? targetValue.slice(9) : targetIndex >= 0 ? String(rawArgv[targetIndex + 1] || "") : "";
      return {
        command,
        targetUser: "owner",
        targetName,
        installDir: "/agent/owner",
        passthrough: stripRinWrapperArgs(rawArgv),
        explicitUser: false,
        explicitTarget: Boolean(targetName),
        hasSavedInstall: false,
        releaseChannel: "stable",
        releaseBranch: "",
        releaseVersion: "",
        explicitReleaseChannel: false,
        updateAssumeYes: rawArgv.includes("--yes"),
        maintenanceMode: !command && rawArgv.includes("--maint"),
      };
    }
  `,
  "dist/core/rin/memory-index.js": `export async function runMemoryIndexInternal(args){globalThis.__rinMainOwnerEvents.push(["memory-index-internal",args])} export async function runMemoryIndex(parsed,args){globalThis.__rinMainOwnerEvents.push(["memory-index",parsed.command,args])}`,
  "dist/core/rin/self-improve.js": `export async function runSelfImproveInternal(args){globalThis.__rinMainOwnerEvents.push(["self-improve-internal",args])} export async function runSelfImprove(parsed,args){globalThis.__rinMainOwnerEvents.push(["self-improve",parsed.command,args])}`,
  "dist/core/rin/status.js": `export async function runStatusInternal(args){globalThis.__rinMainOwnerEvents.push(["status-internal",args])} export async function runStatus(parsed,args){globalThis.__rinMainOwnerEvents.push(["status",parsed.command,args])}`,
  "dist/core/rin/tasks.js": `export async function runTasksInternal(args){globalThis.__rinMainOwnerEvents.push(["tasks-internal",args])} export async function runTasks(parsed,args){globalThis.__rinMainOwnerEvents.push(["tasks",parsed.command,args])}`,
  "dist/core/rin/run.js": `export async function runNonInteractive(parsed,args){globalThis.__rinMainOwnerEvents.push(["run",parsed.command,args])}`,
  "dist/core/rin/extension-command-adapter.js": `export async function tryRunExtensionCommandCli(options){globalThis.__rinMainOwnerEvents.push(["extension-command",options.argv]); return options.argv[0] === "ext-owner"} export async function listExtensionCliCommands(){globalThis.__rinMainOwnerEvents.push(["extension-command-list"]); return [["usage","Show ChatGPT Codex usage and quota"]]}`,
  "dist/core/rin/targets.js": `export async function runTargetCommand(args){globalThis.__rinMainOwnerEvents.push(["target",args])}`,
  "dist/core/rin-targets/runner.js": `
    export function resolveTargetForName(name){globalThis.__rinMainOwnerEvents.push(["resolve-target",name]); return name === "missing" ? undefined : {name};}
    export function runRinOnTarget(target,args){globalThis.__rinMainOwnerEvents.push(["run-target",target.name,args]); return 23;}
  `,
  "dist/core/rin/shared.js": `export async function runUpdate(parsed){globalThis.__rinMainOwnerEvents.push(["update",parsed.command])}`,
  "dist/core/rin/control.js": `export async function runStart(parsed){globalThis.__rinMainOwnerEvents.push(["start",parsed.command])} export async function runStop(parsed){globalThis.__rinMainOwnerEvents.push(["stop",parsed.command])} export async function runRestart(parsed){globalThis.__rinMainOwnerEvents.push(["restart",parsed.command])}`,
  "dist/core/rin/doctor.js": `export async function runDoctor(parsed,args){globalThis.__rinMainOwnerEvents.push(["doctor",parsed.command,args])}`,
  "dist/core/rin/versions.js": `export function runVersions(parsed){globalThis.__rinMainOwnerEvents.push(["versions",parsed.command])} export async function runRollback(parsed){globalThis.__rinMainOwnerEvents.push(["rollback",parsed.command])}`,
  "dist/core/rin/launch.js": `
    export function shouldDelegateCrossUserCli(){return Boolean(globalThis.__rinMainOwnerCrossUser)}
    export async function delegateRinCliToTarget(parsed, argv){globalThis.__rinMainOwnerEvents.push(["delegate-target",parsed.targetUser,argv])}
    export async function launchDefaultRin(parsed){globalThis.__rinMainOwnerEvents.push(["launch",parsed.command,parsed.maintenanceMode,parsed.passthrough])}
  `,
};

const replacementUrls = Object.fromEntries(
  Object.entries(replacements).map(([target, source]) => [
    target,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const cacSource = `
  export function cac() {
    const options = [
      { rawName: "--no-tools", config: { default: true } },
      { rawName: "--no-builtin-tools", config: { default: true } },
    ];
    const cli = {
      globalCommand: { options },
      matchedCommandName: "",
      usage() { return this; },
      option() { return this; },
      help() { return this; },
      command(name) { globalThis.__rinMainOwnerCommands.push(name); return this; },
      parse() {
        const raw = process.argv.slice(2);
        const known = new Set(["update","start","stop","restart","doctor","status","tasks","self-improve","versions","rollback","memory-index","target","version"]);
        this.matchedCommandName = raw.find((value) => known.has(value)) || "";
        return { options: { help: raw.includes("--help") || raw.includes("-h") } };
      },
      outputHelp() { globalThis.__rinMainOwnerEvents.push(["cac-help", options.map((item) => item.config.default)]); },
    };
    return cli;
  }
`;
const cacUrl = `data:text/javascript,${encodeURIComponent(cacSource)}`;
const hookSource = `
const replacements = ${JSON.stringify(replacementUrls)};
const cacUrl = ${JSON.stringify(cacUrl)};
const failedImportUrl = "data:text/javascript,throw%20new%20Error(%27owner_main_import_failed%27)";
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cac") return { url: cacUrl, shortCircuit: true };
  const resolved = await nextResolve(specifier, context);
  if (
    process.env.RIN_TEST_MAIN_IMPORT_FAILURE &&
    resolved.url.endsWith(process.env.RIN_TEST_MAIN_IMPORT_FAILURE)
  ) return { url: failedImportUrl, shortCircuit: true };
  for (const [target, replacementUrl] of Object.entries(replacements)) {
    if (resolved.url.endsWith(target)) return { url: replacementUrl, shortCircuit: true };
  }
  return resolved;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);

globalThis.__rinMainOwnerEvents ||= [];
globalThis.__rinMainOwnerCommands ||= [];
