import { resolveStoredSessionFile } from "./ref.js";

export type RinSessionActivityState =
  | "not started"
  | "idle"
  | "working"
  | "compacting"
  | "stopping"
  | "unavailable";

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, any>)
    : undefined;
}

function currentSessionWorker(
  agentDir: string,
  sessionFile: string,
  activity: unknown,
) {
  const currentFile = resolveStoredSessionFile(agentDir, sessionFile);
  if (!currentFile) return undefined;
  const workers = asRecord(activity)?.workers;
  if (!Array.isArray(workers)) return undefined;
  return workers.find((value) => {
    const worker = asRecord(value);
    return (
      worker &&
      resolveStoredSessionFile(agentDir, worker.sessionFile) === currentFile
    );
  });
}

export function sessionActivityState(input: {
  agentDir: string;
  daemonReachable: boolean;
  sessionFile?: string;
  localTurnActive: boolean;
  activity?: unknown;
}): RinSessionActivityState {
  if (!input.daemonReachable) return "unavailable";
  if (!input.sessionFile) {
    return input.localTurnActive ? "working" : "not started";
  }

  const worker = asRecord(
    currentSessionWorker(input.agentDir, input.sessionFile, input.activity),
  );
  if (
    worker?.gracefulShutdownRequested === true ||
    worker?.state === "stopping"
  ) {
    return "stopping";
  }
  if (worker?.isCompacting === true || worker?.state === "compacting") {
    return "compacting";
  }
  if (
    input.localTurnActive ||
    worker?.working === true ||
    worker?.turnActive === true ||
    worker?.isStreaming === true ||
    worker?.state === "working"
  ) {
    return "working";
  }
  return "idle";
}
