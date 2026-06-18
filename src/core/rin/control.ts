import { tryManagedSystemdAction } from "../rin-install/managed-service.js";
import { sleep } from "../platform/process.js";
import { getBrowseStatus, stopSearxngSidecar } from "../rin-browse/service.js";
import { readDaemonInstanceLockOwner } from "../rin-daemon/lock.js";
import { findSystemUser, targetHomeForUser } from "../rin-install/users.js";
import { startWindowsDaemonProcess } from "../rin-install/service.js";
import {
  createTargetExecutionContext,
  ensureDaemonAvailable,
  ParsedArgs,
  readInstallerManifestForTarget,
  targetPathExists,
  type TargetExecutionContext,
} from "./shared.js";

type ManagedRuntimeService = {
  kind: "systemd" | "launchd" | "windows-startup";
  label: string;
  path?: string;
};

type ManagedRuntimeServiceReadContext = Pick<
  TargetExecutionContext,
  "installDir" | "targetUser" | "currentUser"
> &
  NonNullable<Parameters<typeof readInstallerManifestForTarget>[1]>;

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

function managedRuntimeServiceForAction(context: TargetExecutionContext) {
  const service = readManagedRuntimeService(context);
  if (service.path && !targetPathExists(context, service.path)) {
    throw new Error(`rin_managed_service_missing_path:${service.path}`);
  }
  return service;
}

function tryManagedSystemdServiceAction(
  context: ReturnType<typeof createTargetExecutionContext>,
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
  context: ReturnType<typeof createTargetExecutionContext>,
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

function tryManagedLaunchdServiceAction(
  context: ReturnType<typeof createTargetExecutionContext>,
  service: ManagedRuntimeService,
  action: "start" | "stop" | "restart",
) {
  if (process.platform !== "darwin") {
    throw new Error("rin_managed_service_unsupported:launchd");
  }
  if (!service.path) {
    throw new Error(`rin_managed_service_missing_path:${service.label}`);
  }
  const domain = launchdDomainForTargetUser(context.targetUser);
  const serviceTarget = `${domain}/${service.label}`;
  if (action === "stop") {
    tryBootoutLaunchd(context, domain, service);
    return service.label;
  }
  if (action === "restart") {
    tryBootoutLaunchd(context, domain, service);
  }
  try {
    context.capture(["launchctl", "bootstrap", domain, service.path], {
      stdio: "ignore",
    });
  } catch {}
  context.exec(["launchctl", "kickstart", "-k", serviceTarget]);
  return service.label;
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

async function tryManagedWindowsStartupAction(
  context: ReturnType<typeof createTargetExecutionContext>,
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

async function tryManagedServiceAction(
  context: ReturnType<typeof createTargetExecutionContext>,
  action: "start" | "stop" | "restart",
) {
  const service = managedRuntimeServiceForAction(context);
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

async function waitForDaemonAvailable(
  context: ReturnType<typeof createTargetExecutionContext>,
  timeoutMs = 5000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await context.canConnectSocket()) return true;
    await sleep(150);
  }
  return await context.canConnectSocket();
}

async function waitForDaemonUnavailable(
  context: ReturnType<typeof createTargetExecutionContext>,
  timeoutMs = 5000,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await context.canConnectSocket())) return true;
    await sleep(150);
  }
  return !(await context.canConnectSocket());
}

async function ensureLifecycleDaemonAvailable(
  context: ReturnType<typeof createTargetExecutionContext>,
) {
  if (await waitForDaemonAvailable(context)) return;
  await ensureDaemonAvailable(context);
}

async function stopManagedBrowseSidecars(agentDir: string) {
  const status = getBrowseStatus(agentDir);
  const instances = Array.isArray(status.instances) ? status.instances : [];
  for (const instance of instances) {
    const instanceId = String(instance?.instanceId || "").trim();
    if (!instanceId) continue;
    await stopSearxngSidecar(agentDir, { instanceId }).catch(() => {});
  }
}

export async function runStart(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  const unit = await tryManagedServiceAction(context, "start");
  await ensureLifecycleDaemonAvailable(context);
  console.log(`rin start complete: ${unit}`);
}

export async function runStop(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  const unit = await tryManagedServiceAction(context, "stop");
  await stopManagedBrowseSidecars(context.agentDir);
  if (!(await waitForDaemonUnavailable(context))) {
    throw new Error(
      `rin_stop_incomplete: daemon socket is still reachable for ${context.targetUser}`,
    );
  }
  console.log(`rin stop complete: ${unit}`);
}

export async function runRestart(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  const unit = await tryManagedServiceAction(context, "restart");
  await ensureLifecycleDaemonAvailable(context);
  console.log(`rin restart complete: ${unit}`);
}
