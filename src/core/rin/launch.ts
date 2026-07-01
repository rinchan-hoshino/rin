import os from "node:os";
import path from "node:path";
import { RIN_DIR_ENV } from "../rin-lib/runtime.js";
import { buildUserShell, targetUserRuntimeEnv } from "../rin-lib/system.js";
import {
  createTargetExecutionContext,
  installConfigPath,
  ParsedArgs,
  resolveRuntimeAgentDirForTarget,
  runCommand,
} from "./shared.js";

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
  const tuiArgv = buildDirectTuiArgs(tuiEntry, {
    passthrough: parsed.passthrough,
  });
  return {
    repoRoot: context.repoRoot,
    targetUser: context.targetUser,
    runtimeEnv,
    tuiArgv,
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
