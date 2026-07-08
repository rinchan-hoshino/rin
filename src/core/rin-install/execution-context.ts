import { execFileSync } from "node:child_process";

import { managedNodeExecutablePath } from "./paths.js";
import {
  isSameSystemUser,
  targetHomeForUser as defaultTargetHomeForUser,
} from "./users.js";

export type InstallExecutionContext = {
  currentUser: string;
  targetUser: string;
  targetHome: string;
  installDir: string;
  targetNodePath: string;
  sameUser: boolean;
};

export type InstallExecutionContextOptions = {
  currentUser: string;
  targetUser: string;
  targetHome?: string;
  installDir: string;
  targetNodePath?: string;
};

export type InstallExecutionContextDeps = {
  platform?: NodeJS.Platform;
  targetHomeForUser?: (userName: string) => string;
};

export type TargetUserCommandDeps = {
  runCommandAsUser: (
    targetUser: string,
    command: string,
    args: string[],
    extraEnv?: Record<string, string>,
  ) => void;
  captureCommandAsUser: (
    targetUser: string,
    command: string,
    args: string[],
    extraEnv?: Record<string, string>,
  ) => string;
  execFileSync?: typeof execFileSync;
  env?: NodeJS.ProcessEnv;
};

export function createInstallExecutionContext(
  options: InstallExecutionContextOptions,
  deps: InstallExecutionContextDeps = {},
): InstallExecutionContext {
  const currentUser = String(options.currentUser || "").trim();
  const targetUser = String(options.targetUser || "").trim() || currentUser;
  const targetHomeForUser = deps.targetHomeForUser ?? defaultTargetHomeForUser;
  const targetHome =
    String(options.targetHome || "").trim() || targetHomeForUser(targetUser);
  const installDir = String(options.installDir || "").trim();
  const targetNodePath =
    String(options.targetNodePath || "").trim() ||
    managedNodeExecutablePath(installDir, deps.platform ?? process.platform);

  return {
    currentUser,
    targetUser,
    targetHome,
    installDir,
    targetNodePath,
    sameUser: isSameSystemUser(targetUser, currentUser),
  };
}

export function runInstallTargetCommand(
  context: InstallExecutionContext,
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  deps: TargetUserCommandDeps,
) {
  if (!context.sameUser) {
    deps.runCommandAsUser(context.targetUser, command, args, extraEnv);
    return;
  }
  const execImpl = deps.execFileSync ?? execFileSync;
  execImpl(command, args, {
    stdio: "inherit",
    env: { ...(deps.env ?? process.env), ...extraEnv },
  });
}

export function captureInstallTargetCommand(
  context: InstallExecutionContext,
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
  deps: TargetUserCommandDeps,
) {
  if (!context.sameUser) {
    return deps.captureCommandAsUser(
      context.targetUser,
      command,
      args,
      extraEnv,
    );
  }
  const execImpl = deps.execFileSync ?? execFileSync;
  return String(
    execImpl(command, args, {
      encoding: "utf8",
      env: { ...(deps.env ?? process.env), ...extraEnv },
    }) || "",
  );
}
