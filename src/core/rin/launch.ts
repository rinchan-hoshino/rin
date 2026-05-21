import os from "node:os";
import path from "node:path";
import { buildUserShell, targetUserRuntimeEnv } from "../rin-lib/system.js";
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

async function runTargetCommand(
  targetUser: string,
  argv: string[],
  env: Record<string, string>,
  cwd: string,
) {
  const launch = buildUserShell(targetUser, argv, env);
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
  const { repoRoot, targetUser, runtimeEnv, tuiArgv } =
    await resolveLaunchContext(parsed);

  const code = await runTargetCommand(
    targetUser,
    tuiArgv,
    runtimeEnv as Record<string, string>,
    repoRoot,
  );
  process.exit(code);
}
