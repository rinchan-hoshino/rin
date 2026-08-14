import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

import { bridgeDaemonSocketPath } from "../rin-lib/common.js";
import {
  buildDaemonSocketProbeScript,
  canConnectDaemonSocket,
} from "../rin-daemon/client.js";
import { RIN_DIR_ENV } from "../rin-lib/runtime.js";
import {
  buildUserShell,
  isSameSystemUser,
  readPasswdUser,
  socketPathForUser,
  targetUserRuntimeEnv,
} from "../rin-lib/system.js";
import { defaultInstallDirForHome } from "../rin-install/paths.js";
import { safeString } from "./shared-lite.js";

type TargetUserExecutionDependencies = {
  buildUserShell?: typeof buildUserShell;
  canConnectDaemonSocket?: typeof canConnectDaemonSocket;
  execFileSync?: (
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => unknown;
  fileExists?: (filePath: string) => boolean;
};

export function resolveRuntimeAgentDirForTarget(
  targetUser: string,
  currentUser: string,
  installDir: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const normalizedTargetUser = safeString(targetUser).trim();
  const processUser = os.userInfo().username;
  const normalizedCurrentUser = safeString(currentUser || processUser).trim();
  const normalizedProcessUser = safeString(processUser).trim();
  const normalizedInstallDir = safeString(installDir).trim();
  const explicitRinDir = safeString(env[RIN_DIR_ENV]).trim();
  if (
    explicitRinDir &&
    (!normalizedTargetUser ||
      isSameSystemUser(normalizedTargetUser, normalizedCurrentUser) ||
      isSameSystemUser(normalizedTargetUser, normalizedProcessUser))
  ) {
    return explicitRinDir;
  }
  return normalizedInstallDir || explicitRinDir;
}

export function createTargetUserExecutionContext(
  options: {
    targetUser: string;
    currentUser?: string;
    targetHome?: string;
    installDir?: string;
    cwd?: string;
  },
  dependencies: TargetUserExecutionDependencies = {},
) {
  const currentUser = safeString(
    options.currentUser || os.userInfo().username,
  ).trim();
  const targetUser = safeString(options.targetUser || currentUser).trim();
  const targetHome =
    safeString(options.targetHome).trim() ||
    readPasswdUser(targetUser)?.home ||
    os.homedir();
  const installDir =
    safeString(options.installDir).trim() ||
    defaultInstallDirForHome(targetHome);
  const agentDir = resolveRuntimeAgentDirForTarget(
    targetUser,
    currentUser,
    installDir,
  );
  const runtimeEnv = targetUserRuntimeEnv(targetUser, {
    [RIN_DIR_ENV]: agentDir,
  });
  const fileExists = dependencies.fileExists || fs.existsSync;
  const systemctl =
    process.platform === "linux"
      ? fileExists("/usr/bin/systemctl")
        ? "/usr/bin/systemctl"
        : fileExists("/bin/systemctl")
          ? "/bin/systemctl"
          : ""
      : "";
  const isTargetUser = !targetUser || isSameSystemUser(targetUser, currentUser);
  const socketPath = isTargetUser
    ? socketPathForUser(targetUser)
    : bridgeDaemonSocketPath(installDir);
  const buildShell = dependencies.buildUserShell || buildUserShell;
  const executeFile = dependencies.execFileSync || execFileSync;

  const execute = (argv: string[], commandOptions: Record<string, unknown>) => {
    const launch = buildShell(targetUser, argv, runtimeEnv);
    return executeFile(launch.command, launch.args, {
      env: launch.env,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...commandOptions,
    });
  };
  const exec = (argv: string[], commandOptions = {}) => {
    execute(argv, { stdio: "inherit", ...commandOptions });
  };
  const capture = (argv: string[], commandOptions = {}) =>
    String(execute(argv, { encoding: "utf8", ...commandOptions }) || "");
  const directSocketProbe =
    dependencies.canConnectDaemonSocket || canConnectDaemonSocket;
  const canConnectSocket = async () => {
    if (isTargetUser) return await directSocketProbe(socketPath, 500);
    try {
      capture(
        [process.execPath, "-e", buildDaemonSocketProbeScript(socketPath, 500)],
        { stdio: "ignore" },
      );
      return true;
    } catch {
      return false;
    }
  };

  return {
    currentUser,
    targetUser,
    targetHome,
    installDir,
    agentDir,
    runtimeEnv,
    systemctl,
    socketPath,
    isTargetUser,
    exec,
    capture,
    canConnectSocket,
  };
}
