import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

import { sleep } from "../platform/process.js";
import { canConnectDaemonSocket } from "../rin-daemon/client.js";
import { readDaemonInstanceLockOwner } from "../rin-daemon/lock.js";
import { bridgeDaemonSocketPath } from "../rin-lib/common.js";
import { RIN_DIR_ENV } from "../rin-lib/runtime.js";
import {
  isSameSystemUser,
  socketPathForUser,
  targetUserRuntimeEnv,
  buildUserShell,
} from "../rin-lib/system.js";
import { tryManagedSystemdAction } from "../rin-install/managed-service.js";
import { startWindowsDaemonProcess } from "../rin-install/service.js";
import { defaultInstallDirForHome } from "../rin-install/paths.js";
import { findSystemUser, targetHomeForUser } from "../rin-install/users.js";
import {
  readInstallerManifestForTarget,
  resolveRuntimeAgentDirForTarget,
  targetPathExists,
  type TargetExecutionContext,
} from "./shared.js";

export type ManagedRuntimeService = {
  kind: "systemd" | "launchd" | "windows-startup";
  label: string;
  path?: string;
};

type ManagedRuntimeServiceReadContext = Pick<
  TargetExecutionContext,
  "installDir" | "targetUser" | "currentUser"
> &
  NonNullable<Parameters<typeof readInstallerManifestForTarget>[1]>;

export type ManagedRuntimeServiceActionContext = Pick<
  TargetExecutionContext,
  | "installDir"
  | "targetUser"
  | "currentUser"
  | "isTargetUser"
  | "agentDir"
  | "socketPath"
  | "systemctl"
  | "exec"
  | "capture"
  | "canConnectSocket"
> &
  NonNullable<Parameters<typeof readInstallerManifestForTarget>[1]>;

export function createManagedRuntimeServiceActionContext(options: {
  targetUser: string;
  installDir: string;
  currentUser?: string;
}): ManagedRuntimeServiceActionContext {
  const currentUser = String(options.currentUser || os.userInfo().username);
  const targetUser = String(options.targetUser || currentUser);
  const targetHome = findSystemUser(targetUser)?.home || os.homedir();
  const installDir = options.installDir || defaultInstallDirForHome(targetHome);
  const agentDir = resolveRuntimeAgentDirForTarget(
    targetUser,
    currentUser,
    installDir,
  );
  const runtimeEnv = targetUserRuntimeEnv(targetUser, {
    [RIN_DIR_ENV]: agentDir,
  });
  const systemctl =
    process.platform === "linux"
      ? fs.existsSync("/usr/bin/systemctl")
        ? "/usr/bin/systemctl"
        : fs.existsSync("/bin/systemctl")
          ? "/bin/systemctl"
          : ""
      : "";
  const isTargetUser = !targetUser || isSameSystemUser(targetUser, currentUser);
  const socketPath = isTargetUser
    ? socketPathForUser(targetUser)
    : bridgeDaemonSocketPath(installDir);
  const exec = (argv: string[], execOptions: any = {}) => {
    const launch = buildUserShell(targetUser, argv, runtimeEnv);
    execFileSync(launch.command, launch.args, {
      stdio: "inherit",
      env: launch.env,
      ...execOptions,
    });
  };
  const capture = (argv: string[], captureOptions: any = {}) => {
    const launch = buildUserShell(targetUser, argv, runtimeEnv);
    return execFileSync(launch.command, launch.args, {
      encoding: "utf8",
      env: launch.env,
      ...captureOptions,
    });
  };
  return {
    installDir,
    targetUser,
    currentUser,
    isTargetUser,
    agentDir,
    socketPath,
    systemctl,
    exec,
    capture,
    canConnectSocket: async () => await canConnectDaemonSocket(socketPath, 500),
  };
}

export function readManagedRuntimeService(
  context: ManagedRuntimeServiceReadContext,
): ManagedRuntimeService {
  const manifest = readInstallerManifestForTarget<any>(context.installDir, {
    targetUser: context.targetUser,
    currentUser: context.currentUser,
    readJson: context.readJson,
    readPrivilegedJson: context.readPrivilegedJson,
  });
  const service = manifest?.service;
  const kind = String(service?.kind || "").trim();
  if (
    (kind === "systemd" || kind === "launchd" || kind === "windows-startup") &&
    String(service.label || "").trim()
  ) {
    return {
      kind,
      label: String(service.label).trim(),
      path: String(service.path || "").trim() || undefined,
    };
  }
  throw new Error(
    `rin_managed_service_missing: ${context.installDir}/installer.json does not record a managed runtime service`,
  );
}

function managedRuntimeServiceForAction(
  context: ManagedRuntimeServiceActionContext,
  explicitService?: ManagedRuntimeService,
) {
  const service = explicitService || readManagedRuntimeService(context);
  if (service.path && !targetPathExists(context, service.path)) {
    throw new Error(`rin_managed_service_missing_path:${service.path}`);
  }
  return service;
}

function tryManagedSystemdServiceAction(
  context: ManagedRuntimeServiceActionContext,
  service: ManagedRuntimeService,
  action: "start" | "stop" | "restart",
) {
  if (!context.systemctl) {
    throw new Error("rin_managed_service_unsupported:systemd");
  }
  const effectiveAction = action === "start" ? "restart" : action;
  const unit = tryManagedSystemdAction([service.label], {
    daemonReload: () =>
      context.capture([context.systemctl, "--user", "daemon-reload"], {
        stdio: "ignore",
      }),
    probeUnit: (candidate) =>
      context.capture([context.systemctl, "--user", "status", candidate], {
        stdio: "ignore",
      }),
    runAction: (candidate) =>
      context.exec([context.systemctl, "--user", effectiveAction, candidate]),
  });
  if (!unit)
    throw new Error(
      `rin_managed_service_action_failed:${action}:${service.label}`,
    );
  return unit;
}

function launchdDomainForTargetUser(targetUser: string) {
  const uid = Number(findSystemUser(targetUser)?.uid ?? -1);
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error(`rin_launchd_target_user_not_found:${targetUser}`);
  }
  return `gui/${uid}`;
}

function tryBootoutLaunchd(
  context: ManagedRuntimeServiceActionContext,
  domain: string,
  service: ManagedRuntimeService,
) {
  for (const target of [
    `${domain}/${service.label}`,
    service.path || "",
  ].filter(Boolean)) {
    try {
      context.capture(["launchctl", "bootout", target], { stdio: "ignore" });
      return true;
    } catch {}
  }
  return false;
}

function forceStopDaemonLockOwner(context: ManagedRuntimeServiceActionContext) {
  const owner = readDaemonInstanceLockOwner(context.agentDir);
  const pid = Number(owner?.pid || 0);
  const ownerSocketPath = String(owner?.socketPath || "").trim();
  if (
    !Number.isInteger(pid) ||
    pid <= 1 ||
    pid === process.pid ||
    ownerSocketPath !== context.socketPath
  ) {
    return false;
  }
  try {
    const openFiles = context.capture([
      "/usr/sbin/lsof",
      "-a",
      "-p",
      String(pid),
      "-U",
      "-Fn",
    ]);
    const ownsSocket = String(openFiles)
      .split(/\r?\n/)
      .some((line) => line === `n${context.socketPath}`);
    if (!ownsSocket) return false;
    process.kill(pid, "SIGKILL");
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") return true;
    return false;
  }
}

export async function runManagedLaunchdServiceAction(
  context: ManagedRuntimeServiceActionContext,
  service: ManagedRuntimeService,
  action: "start" | "stop" | "restart",
  deps: {
    resolveDomain?: (targetUser: string) => string;
    waitForDaemonUnavailable?: typeof waitForDaemonUnavailable;
    forceStopDaemon?: typeof forceStopDaemonLockOwner;
  } = {},
) {
  if (!service.path) {
    throw new Error(`rin_managed_service_missing_path:${service.label}`);
  }
  const domain = (deps.resolveDomain || launchdDomainForTargetUser)(
    context.targetUser,
  );
  const serviceTarget = `${domain}/${service.label}`;
  if (action === "restart") {
    const bootedOut = tryBootoutLaunchd(context, domain, service);
    const shouldWaitForShutdown =
      bootedOut || (await context.canConnectSocket());
    if (shouldWaitForShutdown) {
      const waitUntilUnavailable =
        deps.waitForDaemonUnavailable || waitForDaemonUnavailable;
      const gracefullyUnavailable = await waitUntilUnavailable(context, 5_000);
      if (!gracefullyUnavailable) {
        const forced = (deps.forceStopDaemon || forceStopDaemonLockOwner)(
          context,
        );
        if (!forced || !(await waitUntilUnavailable(context, 5_000))) {
          throw new Error("rin_launchd_daemon_stop_incomplete");
        }
      }
    }
    context.capture(["launchctl", "bootstrap", domain, service.path], {
      stdio: "ignore",
    });
    return service.label;
  }
  if (action === "stop") {
    const bootedOut = tryBootoutLaunchd(context, domain, service);
    if (bootedOut) {
      const unavailable = await (
        deps.waitForDaemonUnavailable || waitForDaemonUnavailable
      )(context);
      if (!unavailable) {
        throw new Error("rin_launchd_daemon_stop_incomplete");
      }
    } else if (await context.canConnectSocket()) {
      throw new Error("rin_launchd_daemon_stop_incomplete");
    }
    return service.label;
  }
  let bootstrapped = false;
  try {
    context.capture(["launchctl", "bootstrap", domain, service.path], {
      stdio: "ignore",
    });
    bootstrapped = true;
  } catch {}
  if (!bootstrapped) {
    context.exec(["launchctl", "kickstart", serviceTarget]);
  }
  return service.label;
}

async function tryManagedLaunchdServiceAction(
  context: ManagedRuntimeServiceActionContext,
  service: ManagedRuntimeService,
  action: "start" | "stop" | "restart",
) {
  if (process.platform !== "darwin") {
    throw new Error("rin_managed_service_unsupported:launchd");
  }
  return await runManagedLaunchdServiceAction(context, service, action);
}

function stopWindowsDaemonFromLock(agentDir: string) {
  const pid = Number(readDaemonInstanceLockOwner(agentDir)?.pid || 0);
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch (error: any) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForDaemonUnavailable(
  context: ManagedRuntimeServiceActionContext,
  timeoutMs = 5000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await context.canConnectSocket())) return true;
    await sleep(150);
  }
  return !(await context.canConnectSocket());
}

async function tryManagedWindowsStartupAction(
  context: ManagedRuntimeServiceActionContext,
  service: ManagedRuntimeService,
  action: "start" | "stop" | "restart",
) {
  if (process.platform !== "win32") {
    throw new Error("rin_managed_service_unsupported:windows-startup");
  }
  if (!context.isTargetUser) {
    throw new Error(
      `rin_windows_daemon_cross_user_unsupported:${context.targetUser}`,
    );
  }
  if (action === "stop" || action === "restart") {
    const signaled = stopWindowsDaemonFromLock(context.agentDir);
    if (signaled) await waitForDaemonUnavailable(context);
    if (!signaled && (await context.canConnectSocket())) {
      throw new Error("rin_windows_daemon_pid_missing");
    }
  }
  if (action === "start" || action === "restart") {
    if (!(await context.canConnectSocket())) {
      startWindowsDaemonProcess(context.targetUser, context.installDir, {
        targetHomeForUser,
      });
    }
  }
  return service.label;
}

export async function tryManagedServiceAction(
  context: ManagedRuntimeServiceActionContext,
  action: "start" | "stop" | "restart",
  explicitService?: ManagedRuntimeService,
) {
  const service = managedRuntimeServiceForAction(context, explicitService);
  if (service.kind === "systemd") {
    return tryManagedSystemdServiceAction(context, service, action);
  }
  if (service.kind === "launchd") {
    return tryManagedLaunchdServiceAction(context, service, action);
  }
  if (service.kind === "windows-startup") {
    return await tryManagedWindowsStartupAction(context, service, action);
  }
  throw new Error(`rin_managed_service_unsupported:${(service as any).kind}`);
}
