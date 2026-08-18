import fs from "node:fs";
import { asArray, isJsonRecord } from "../json-utils.js";
import {
  inspectTranscriptSearchHealth,
  type TranscriptSearchHealth,
} from "../memory/transcript-search.js";
import {
  findManagedSystemdJournalSnapshot,
  findManagedSystemdStatusSnapshot,
} from "../rin-install/managed-service.js";
import { systemdUserUnitPathForHome } from "../rin-install/paths.js";
import {
  createTargetExecutionContext,
  extractSubcommandArgv,
  safeString,
  targetPathExists,
  type ParsedArgs,
  type TargetExecutionContext,
} from "./shared.js";

export type DoctorCliOptions = {
  json: boolean;
  help: boolean;
};

export type DoctorBackendSnapshot = {
  targetUser: string;
  installDir: string;
  socketPath: string;
  socketReady: boolean;
  serviceManager: "systemd-user" | "none";
  memoryIndex: TranscriptSearchHealth;
  daemonStatus?: unknown;
  chatStatus?: unknown;
  systemdLines: string[];
};

function asRecord(value: unknown): Record<string, any> | undefined {
  return isJsonRecord(value) ? value : undefined;
}

function printDoctorHelp() {
  console.log(
    [
      "rin doctor [options]",
      "",
      "Frontend view:",
      "  Shows a compact systemctl-style Rin health page and recent service logs.",
      "",
      "Backend view:",
      "  --json               print the complete daemon/service health snapshot",
      "  --help               show this help",
    ].join("\n"),
  );
}

export function parseDoctorArgs(argv: string[]): DoctorCliOptions {
  const args = extractSubcommandArgv(argv, "doctor");
  const result: DoctorCliOptions = { json: false, help: false };
  for (const rawArg of args) {
    const arg = safeString(rawArg).trim();
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    throw new Error(`unknown_doctor_arg:${arg}`);
  }
  return result;
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

function formatDoctorValue(value: unknown, fallback = "-") {
  const text = safeString(value).trim();
  return text || fallback;
}

function extractServiceUnit(systemdLines: string[]) {
  const line = systemdLines.find((item) => item.startsWith("serviceUnit="));
  return line?.slice("serviceUnit=".length).trim() || "rin-daemon";
}

function extractServiceLogs(systemdLines: string[], limit = 8) {
  const journalIndex = systemdLines.findIndex((line) =>
    line.startsWith("serviceJournal="),
  );
  if (journalIndex < 0) return [];
  return systemdLines
    .slice(journalIndex + 1)
    .filter(Boolean)
    .slice(-limit);
}

export function renderDoctorBackendLines(snapshot: DoctorBackendSnapshot) {
  return [
    `targetUser=${snapshot.targetUser}`,
    `installDir=${snapshot.installDir}`,
    `socketPath=${snapshot.socketPath}`,
    `socketReady=${snapshot.socketReady ? "yes" : "no"}`,
    `serviceManager=${snapshot.serviceManager}`,
    `memoryIndexStatus=${snapshot.memoryIndex.status}`,
    `memoryIndexSchema=${String(snapshot.memoryIndex.schemaVersion ?? "-")}/${String(snapshot.memoryIndex.expectedSchemaVersion)}`,
    `memoryIndexRebuildRequired=${snapshot.memoryIndex.rebuildRequired === null ? "unknown" : snapshot.memoryIndex.rebuildRequired ? "yes" : "no"}`,
    `memoryIndexDirtyMarkers=${String(snapshot.memoryIndex.dirtyMarkerCount)}`,
    `memoryIndexStaleDirtyMarkers=${String(snapshot.memoryIndex.staleDirtyMarkerCount)}`,
    `memoryIndexReasons=${snapshot.memoryIndex.reasons.join(",") || "-"}`,
    ...renderChatBridgeDoctorLines(snapshot.chatStatus),
    ...renderDaemonWorkerDoctorLines(snapshot.daemonStatus),
    ...snapshot.systemdLines,
  ];
}

export function renderDoctorReport(snapshot: DoctorBackendSnapshot) {
  const daemonStatus = asRecord(snapshot.daemonStatus) ?? {};
  const chatStatus = asRecord(snapshot.chatStatus) ?? {};
  const workers = asArray(daemonStatus.workers);
  const activeWorkers = workers.filter((worker) => {
    const value = asRecord(worker) ?? {};
    const state = safeString(value.state).trim();
    return state === "working" || state === "stopping" || value.isStreaming;
  }).length;
  const active = snapshot.socketReady ? "active (running)" : "inactive (dead)";
  const unit = extractServiceUnit(snapshot.systemdLines);
  const logs = extractServiceLogs(snapshot.systemdLines);
  const memoryDetail = snapshot.memoryIndex.reasons.length
    ? snapshot.memoryIndex.reasons.join(", ")
    : snapshot.memoryIndex.status === "ready"
      ? `schema ${String(snapshot.memoryIndex.schemaVersion)}`
      : "not created yet";
  const lines = [
    `● ${unit} - Rin daemon`,
    `   Loaded: ${snapshot.serviceManager === "systemd-user" ? "loaded" : "not-found"} (${snapshot.serviceManager})`,
    `   Active: ${active}`,
    `   Socket: ${formatDoctorValue(snapshot.socketPath)} (${snapshot.socketReady ? "ready" : "unavailable"})`,
    `   Install: ${formatDoctorValue(snapshot.installDir)} · user ${formatDoctorValue(snapshot.targetUser)}`,
    `   Workers: ${String(daemonStatus.workerCount ?? workers.length)} total, ${String(activeWorkers)} active`,
    `   Chat bridge: ${chatStatus.ready ? "ready" : "not ready"} (${String(chatStatus.botCount ?? 0)} bots, ${String(chatStatus.adapterCount ?? 0)} adapters)`,
    `   Memory index: ${snapshot.memoryIndex.status} (${memoryDetail})`,
  ];
  if (logs.length) {
    lines.push("", "Logs:", ...logs.map((line) => `   ${line}`));
  }
  return lines.join("\n");
}

async function collectDoctorSnapshot(
  context: TargetExecutionContext,
): Promise<DoctorBackendSnapshot> {
  const socketReady = await context.canConnectSocket();
  const daemonStatus = socketReady
    ? await context.queryDaemonStatus()
    : undefined;
  return {
    targetUser: context.targetUser,
    installDir: context.installDir,
    socketPath: context.socketPath,
    socketReady,
    serviceManager: context.systemctl ? "systemd-user" : "none",
    memoryIndex: inspectTranscriptSearchHealth(context.agentDir),
    daemonStatus,
    chatStatus: asRecord(daemonStatus)?.chat,
    systemdLines: collectSystemdDoctorLines(context),
  };
}

export async function runDoctor(parsed: ParsedArgs, rawArgv: string[] = []) {
  const options = parseDoctorArgs(rawArgv);
  if (options.help) {
    printDoctorHelp();
    return;
  }
  const context = createTargetExecutionContext(parsed);
  const snapshot = await collectDoctorSnapshot(context);
  console.log(
    options.json
      ? JSON.stringify(snapshot, null, 2)
      : renderDoctorReport(snapshot),
  );
}
