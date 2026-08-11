import os from "node:os";
import path from "node:path";
import { installedRuntimeNodeCommandArgs } from "../rin-install/fs-utils.js";
import { RIN_DIR_ENV } from "../rin-lib/runtime.js";
import {
  buildUserShell,
  isSameSystemUser,
  targetUserRuntimeEnv,
} from "../rin-lib/system.js";
import {
  RIN_TUI_MAINTENANCE_REQUESTED_ENV,
  RIN_TUI_MAINTENANCE_ROLE,
  RIN_TUI_RUNTIME_ROLE_ENV,
} from "../tui-runtime-env.js";
import {
  assertDaemonAvailable,
  createTargetExecutionContext,
  installConfigPath,
  ParsedArgs,
  resolveRuntimeAgentDirForTarget,
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

export function buildTuiRuntimeEnv(
  targetUser: string,
  currentUser: string,
  installDir?: string,
) {
  const runtimeAgentDir = resolveRuntimeAgentDirForTarget(
    targetUser,
    currentUser,
    installDir || "",
  );
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

export function shouldDelegateCrossUserCli(
  parsed: ParsedArgs,
  currentUser = os.userInfo().username,
) {
  return Boolean(
    !parsed.explicitTarget &&
    parsed.targetUser &&
    !isSameSystemUser(parsed.targetUser, currentUser),
  );
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

function maintenanceRuntimeEnv(
  runtimeEnv: NodeJS.ProcessEnv,
  requested: boolean,
) {
  const maintenanceEnv = {
    ...runtimeEnv,
    [RIN_TUI_RUNTIME_ROLE_ENV]: RIN_TUI_MAINTENANCE_ROLE,
  };
  if (requested) {
    maintenanceEnv[RIN_TUI_MAINTENANCE_REQUESTED_ENV] = "1";
  } else {
    delete maintenanceEnv[RIN_TUI_MAINTENANCE_REQUESTED_ENV];
  }
  return maintenanceEnv;
}

export async function resolveTuiLaunchEnvironment(
  context: ReturnType<typeof createTargetExecutionContext>,
  runtimeEnv: NodeJS.ProcessEnv,
  deps: {
    assertDaemonAvailable?: typeof assertDaemonAvailable;
    forceMaintenance?: boolean;
  } = {},
): Promise<{ runtimeEnv: NodeJS.ProcessEnv; maintenanceModeNotice?: string }> {
  if (deps.forceMaintenance) {
    return { runtimeEnv: maintenanceRuntimeEnv(runtimeEnv, true) };
  }
  try {
    await (deps.assertDaemonAvailable || assertDaemonAvailable)(context);
    return { runtimeEnv };
  } catch (error) {
    return {
      runtimeEnv: maintenanceRuntimeEnv(runtimeEnv, false),
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
    { forceMaintenance: parsed.maintenanceMode },
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

export async function delegateRinCliToTarget(
  parsed: ParsedArgs,
  argv: string[],
) {
  const context = createTargetExecutionContext(parsed);
  const currentUser = os.userInfo().username;
  const runtimeEnv = buildTuiRuntimeEnv(
    context.targetUser,
    currentUser,
    parsed.installDir,
  );
  const cliEntry = path.join(context.repoRoot, "dist", "app", "rin", "main.js");
  const [targetNode] = installedRuntimeNodeCommandArgs({
    installDir: context.installDir,
  });
  const code = await runTargetCommand(
    context.targetUser,
    [targetNode, cliEntry, ...argv],
    runtimeEnv as Record<string, string>,
    context.repoRoot,
  );
  process.exitCode = code;
  return code;
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
