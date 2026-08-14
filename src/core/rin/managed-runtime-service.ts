import os from "node:os";

import { sleep } from "../platform/process.js";
import { readDaemonInstanceLockOwner } from "../rin-daemon/lock.js";
import { tryManagedSystemdAction } from "../rin-install/managed-service.js";
import { startWindowsDaemonProcess } from "../rin-install/service.js";
import { findSystemUser, targetHomeForUser } from "../rin-install/users.js";
import {
  readInstallerManifestForTarget,
  targetPathExists,
  type TargetExecutionContext,
} from "./shared.js";
import { createTargetUserExecutionContext } from "./target-user-execution.js";

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
  return createTargetUserExecutionContext({
    ...options,
    targetHome: findSystemUser(options.targetUser)?.home || os.homedir(),
  });
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

export function runManagedSystemdServiceAction(
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
    // `systemctl status` exits non-zero for a loaded but intentionally
    // inactive unit. The recorded unit is authoritative; the action itself is
    // the correct existence and permission check.
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

export async function runManagedLaunchdServiceAction(
  context: ManagedRuntimeServiceActionContext,
  service: ManagedRuntimeService,
  action: "start" | "stop" | "restart",
  deps: {
    resolveDomain?: (targetUser: string) => string;
    waitForDaemonUnavailable?: typeof waitForDaemonUnavailable;
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
    return runManagedSystemdServiceAction(context, service, action);
  }
  if (service.kind === "launchd") {
    return tryManagedLaunchdServiceAction(context, service, action);
  }
  if (service.kind === "windows-startup") {
    return await tryManagedWindowsStartupAction(context, service, action);
  }
  throw new Error(`rin_managed_service_unsupported:${(service as any).kind}`);
}
