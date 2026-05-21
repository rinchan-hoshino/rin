import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  buildUserShell,
  shellQuote,
  targetUserRuntimeEnv,
} from "../rin-lib/system.js";
import { RIN_DIR_ENV } from "../rin-lib/runtime.js";
import {
  createTargetExecutionContext,
  ensureDaemonAvailable,
  installConfigPath,
  ParsedArgs,
  runCommand,
  safeString,
} from "./shared.js";

export function formatMaintenanceModeNotice(error: unknown) {
  const detail = safeString((error as any)?.message || error).trim();
  const suffix = detail ? ` (${detail})` : "";
  return [
    `Rin daemon is unavailable${suffix}.`,
    "Entering temporary maintenance mode.",
    "Some features may be unavailable or not match daemon/RPC behavior.",
  ].join("\n");
}

function resolveTuiRuntimeAgentDir(installDir?: string) {
  return (
    String(process.env[RIN_DIR_ENV] || "").trim() ||
    String(installDir || "").trim()
  );
}

export function buildTuiRuntimeEnv(
  targetUser: string,
  currentUser: string,
  installDir?: string,
) {
  const runtimeAgentDir = resolveTuiRuntimeAgentDir(installDir);
  return targetUserRuntimeEnv(targetUser, {
    ...(runtimeAgentDir
      ? {
          [RIN_DIR_ENV]: runtimeAgentDir,
        }
      : {}),
  });
}

export function buildDirectTuiArgs(
  tuiEntry: string,
  options: { passthrough: string[] },
) {
  return [process.execPath, tuiEntry, ...options.passthrough];
}

function isValidShellEnvName(name: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function buildTuiEnvironmentScript(env: NodeJS.ProcessEnv) {
  const exports = Object.entries(env)
    .filter(
      (entry): entry is [string, string] =>
        isValidShellEnvName(entry[0]) && entry[1] !== undefined,
    )
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  return [...exports, 'exec "$@"', ""].join("\n");
}

async function runCommandWithInput(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd: string },
  input: string,
) {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "inherit", "inherit"],
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) return reject(new Error(`terminated:${signal}`));
      resolve(code ?? 0);
    });
    child.stdin.end(input);
  });
}

async function runTargetCommand(
  targetUser: string,
  argv: string[],
  env: Record<string, string>,
  cwd: string,
) {
  const launch = buildUserShell(targetUser, argv, env);
  if (launch.command.endsWith("sudo")) {
    return await runCommandWithInput(
      launch.command,
      ["-u", targetUser, "sh", "-s", "--", ...argv],
      {
        env: launch.env,
        cwd,
      },
      buildTuiEnvironmentScript(launch.env),
    );
  }
  return await runCommand(launch.command, launch.args, {
    env: launch.env,
    cwd,
  });
}

export async function resolveTuiLaunchEnvironment(
  context: ReturnType<typeof createTargetExecutionContext>,
  runtimeEnv: NodeJS.ProcessEnv,
  deps: {
    ensureDaemonAvailable?: typeof ensureDaemonAvailable;
  } = {},
): Promise<{ runtimeEnv: NodeJS.ProcessEnv; maintenanceModeNotice?: string }> {
  try {
    await (deps.ensureDaemonAvailable || ensureDaemonAvailable)(context);
    return { runtimeEnv };
  } catch (error) {
    return {
      runtimeEnv,
      maintenanceModeNotice: formatMaintenanceModeNotice(error),
    };
  }
}

async function resolveLaunchContext(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  const currentUser = os.userInfo().username;
  const runtimeEnv = buildTuiRuntimeEnv(
    context.targetUser,
    currentUser,
    parsed.installDir,
  );
  const tuiEntry = path.join(
    context.repoRoot,
    "dist",
    "app",
    "rin-tui",
    "main.js",
  );
  const launchEnvironment = await resolveTuiLaunchEnvironment(
    context,
    runtimeEnv,
  );
  const tuiArgv = buildDirectTuiArgs(tuiEntry, {
    passthrough: parsed.passthrough,
  });
  return {
    repoRoot: context.repoRoot,
    targetUser: context.targetUser,
    runtimeEnv: launchEnvironment.runtimeEnv,
    tuiArgv,
    maintenanceModeNotice: launchEnvironment.maintenanceModeNotice,
  };
}

export async function launchDefaultRin(parsed: ParsedArgs) {
  if (!parsed.explicitUser && !parsed.hasSavedInstall) {
    throw new Error(
      `rin_not_installed: run rin-install first or pass --user/-u explicitly (expected ${installConfigPath()})`,
    );
  }
  const { repoRoot, targetUser, runtimeEnv, tuiArgv, maintenanceModeNotice } =
    await resolveLaunchContext(parsed);
  if (maintenanceModeNotice) console.error(maintenanceModeNotice);

  const code = await runTargetCommand(
    targetUser,
    tuiArgv,
    runtimeEnv as Record<string, string>,
    repoRoot,
  );
  process.exit(code);
}
