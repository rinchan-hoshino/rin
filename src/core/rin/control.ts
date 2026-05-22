import fs from "node:fs";

import { tryManagedSystemdAction } from "../rin-install/managed-service.js";
import { readJsonFile } from "../platform/fs.js";
import { sleep } from "../platform/process.js";
import {
  getWebSearchStatus,
  stopSearxngSidecar,
} from "../rin-web-search/service.js";
import {
  createTargetExecutionContext,
  ensureDaemonAvailable,
  ParsedArgs,
} from "./shared.js";

type ManagedRuntimeService = {
  kind: "systemd";
  label: string;
  path?: string;
};

function readManagedRuntimeService(
  context: ReturnType<typeof createTargetExecutionContext>,
): ManagedRuntimeService {
  const manifest = readJsonFile<any>(
    `${context.installDir}/installer.json`,
    {},
  );
  const service = manifest?.service;
  if (service?.kind === "systemd" && String(service.label || "").trim()) {
    return {
      kind: "systemd",
      label: String(service.label).trim(),
      path: String(service.path || "").trim() || undefined,
    };
  }
  throw new Error(
    `rin_managed_service_missing: ${context.installDir}/installer.json does not record a managed runtime service`,
  );
}

function managedRuntimeServiceForAction(
  context: ReturnType<typeof createTargetExecutionContext>,
) {
  const service = readManagedRuntimeService(context);
  if (service.kind !== "systemd" || !context.systemctl) {
    throw new Error(`rin_managed_service_unsupported:${service.kind}`);
  }
  if (service.path && !fs.existsSync(service.path)) {
    throw new Error(`rin_managed_service_missing_path:${service.path}`);
  }
  return service;
}

function tryManagedServiceAction(
  context: ReturnType<typeof createTargetExecutionContext>,
  action: "start" | "stop" | "restart",
) {
  const service = managedRuntimeServiceForAction(context);
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

async function stopManagedWebSearchSidecars(agentDir: string) {
  const status = getWebSearchStatus(agentDir);
  const instances = Array.isArray(status.instances) ? status.instances : [];
  for (const instance of instances) {
    const instanceId = String(instance?.instanceId || "").trim();
    if (!instanceId) continue;
    await stopSearxngSidecar(agentDir, { instanceId }).catch(() => {});
  }
}

export async function runStart(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  const unit = tryManagedServiceAction(context, "start");
  await ensureDaemonAvailable(context);
  console.log(`rin start complete: ${unit}`);
}

export async function runStop(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  const unit = tryManagedServiceAction(context, "stop");
  await stopManagedWebSearchSidecars(context.agentDir);
  if (!(await waitForDaemonUnavailable(context))) {
    throw new Error(
      `rin_stop_incomplete: daemon socket is still reachable for ${context.targetUser}`,
    );
  }
  console.log(`rin stop complete: ${unit}`);
}

export async function runRestart(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  const unit = tryManagedServiceAction(context, "restart");
  await ensureDaemonAvailable(context);
  console.log(`rin restart complete: ${unit}`);
}
