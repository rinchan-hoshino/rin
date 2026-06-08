import fs from "node:fs";
import { asArray, isJsonRecord } from "../json-utils.js";
import {
  findManagedSystemdJournalSnapshot,
  findManagedSystemdStatusSnapshot,
} from "../rin-install/managed-service.js";
import { systemdUserUnitPathForHome } from "../rin-install/paths.js";
import {
  createTargetExecutionContext,
  targetPathExists,
  type ParsedArgs,
  type TargetExecutionContext,
} from "./shared.js";

function asRecord(value: unknown): Record<string, any> | undefined {
  return isJsonRecord(value) ? value : undefined;
}

export function renderWebSearchDoctorLines(webSearchStatus: unknown) {
  const status = asRecord(webSearchStatus);
  const runtime = asRecord(status?.runtime);
  const providers = asArray(runtime?.providers);
  const instances = asArray(status?.instances);
  return [
    `webSearchRuntimeReady=${runtime?.ready ? "yes" : "no"}`,
    `webSearchMode=${String(runtime?.mode || "unknown")}`,
    `webSearchProviderCount=${String(runtime?.providerCount ?? 0)}`,
    `webSearchInstanceCount=${String(instances.length)}`,
    ...providers.map((provider) => `webSearchProvider=${String(provider)}`),
    ...instances.map((instance) => {
      const value = asRecord(instance) ?? {};
      return `webSearchInstance=${value.instanceId} pid=${String(value.pid || 0)} alive=${value.alive ? "yes" : "no"} port=${String(value.port || "")} baseUrl=${value.baseUrl || ""}`;
    }),
  ];
}

export function renderChatBridgeDoctorLines(chatStatus: unknown) {
  const status = asRecord(chatStatus);
  return [
    `chatBridgeReady=${status?.ready ? "yes" : "no"}`,
    `chatBridgeAdapterCount=${String(status?.adapterCount ?? 0)}`,
    `chatBridgeBotCount=${String(status?.botCount ?? 0)}`,
    `chatBridgeControllerCount=${String(status?.controllerCount ?? 0)}`,
    `chatBridgeDetachedControllerCount=${String(status?.detachedControllerCount ?? 0)}`,
  ];
}

export function renderDaemonWorkerDoctorLines(daemonStatus: unknown) {
  const status = asRecord(daemonStatus);
  if (!status) return [];
  return [
    `daemonWorkerCount=${String(status.workerCount ?? 0)}`,
    ...asArray(status.workers).map((worker) => {
      const value = asRecord(worker) ?? {};
      const sessionFile = value.sessionFile ? String(value.sessionFile) : "-";
      return `daemonWorker=${String(value.id)} pid=${String(value.pid)} role=${String(value.role)} attached=${String(value.attachedConnections)} pending=${String(value.pendingResponses)} streaming=${String(value.isStreaming)} compacting=${String(value.isCompacting)} session=${sessionFile}`;
    }),
  ];
}

export function existingManagedSystemdUnitsForDoctor(
  units: string[],
  targetHome: string,
  unitExists: (filePath: string) => boolean = fs.existsSync,
) {
  return units.filter((unit) =>
    unitExists(systemdUserUnitPathForHome(targetHome, unit)),
  );
}

type DoctorSystemdContext = Pick<
  TargetExecutionContext,
  | "capture"
  | "isTargetUser"
  | "managedServiceUnits"
  | "systemctl"
  | "targetHome"
>;

export function collectSystemdDoctorLines(
  context: DoctorSystemdContext,
  unitExists: (filePath: string) => boolean = (filePath) =>
    targetPathExists(context, filePath, fs.existsSync),
) {
  const lines: string[] = [];
  if (!context.systemctl) return lines;

  const existingUnits = existingManagedSystemdUnitsForDoctor(
    context.managedServiceUnits,
    context.targetHome,
    unitExists,
  );
  if (!existingUnits.length) return lines;

  const status = findManagedSystemdStatusSnapshot(existingUnits, (unit) =>
    context.capture([
      context.systemctl,
      "--user",
      "status",
      unit,
      "--no-pager",
      "-l",
    ]),
  );
  if (status) {
    lines.push(`serviceUnit=${status.unit}`, "serviceStatus:", ...status.lines);
  }

  const journal = findManagedSystemdJournalSnapshot(existingUnits, (unit) =>
    context.capture([
      "journalctl",
      "--user",
      "-u",
      unit,
      "-n",
      "20",
      "--no-pager",
    ]),
  );
  if (journal) {
    lines.push(`serviceJournal=${journal.unit}`, ...journal.lines);
  }

  return lines;
}

export async function runDoctor(parsed: ParsedArgs) {
  const context = createTargetExecutionContext(parsed);
  const socketReady = await context.canConnectSocket();
  const daemonStatus = socketReady
    ? await context.queryDaemonStatus()
    : undefined;
  const webSearchStatus = daemonStatus?.webSearch;
  const chatStatus = daemonStatus?.chat;
  const lines = [
    `targetUser=${context.targetUser}`,
    `installDir=${context.installDir}`,
    `socketPath=${context.socketPath}`,
    `socketReady=${socketReady ? "yes" : "no"}`,
    `serviceManager=${context.systemctl ? "systemd-user" : "none"}`,
  ];

  lines.push(
    ...renderWebSearchDoctorLines(webSearchStatus),
    ...renderChatBridgeDoctorLines(chatStatus),
    ...renderDaemonWorkerDoctorLines(daemonStatus),
    ...collectSystemdDoctorLines(context),
  );

  console.log(lines.join("\n"));
}
