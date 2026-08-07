import { requestDaemonCommand } from "../rin-daemon/client.js";
import { resolveStoredSessionFile } from "../session/ref.js";

export type ChatSessionState =
  | "not started"
  | "idle"
  | "working"
  | "compacting"
  | "stopping"
  | "unavailable";

export type ChatSessionStatus = {
  session: ChatSessionState;
};

type ChatSessionStatusInput = {
  agentDir: string;
  daemonReachable: boolean;
  sessionFile?: string;
  localTurnActive: boolean;
  activity?: unknown;
};

type ChatSessionStatusQuery = Omit<
  ChatSessionStatusInput,
  "daemonReachable" | "activity"
>;

type DaemonActivityLoader = () => Promise<unknown>;

const CHAT_STATUS_REQUEST_TIMEOUT_MS = 3_000;

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

export function buildChatSessionStatus(
  input: ChatSessionStatusInput,
): ChatSessionStatus {
  if (!input.daemonReachable) {
    return { session: "unavailable" };
  }
  if (!input.sessionFile) {
    return {
      session: input.localTurnActive ? "working" : "not started",
    };
  }

  const worker = asRecord(
    currentSessionWorker(input.agentDir, input.sessionFile, input.activity),
  );
  let session: ChatSessionState = input.localTurnActive ? "working" : "idle";
  if (
    worker?.gracefulShutdownRequested === true ||
    worker?.state === "stopping"
  ) {
    session = "stopping";
  } else if (worker?.isCompacting === true || worker?.state === "compacting") {
    session = "compacting";
  } else if (
    worker?.working === true ||
    worker?.turnActive === true ||
    worker?.isStreaming === true ||
    worker?.state === "working"
  ) {
    session = "working";
  }
  return { session };
}

export async function readChatSessionStatus(
  input: ChatSessionStatusQuery,
  loadActivity: DaemonActivityLoader,
): Promise<ChatSessionStatus> {
  try {
    return buildChatSessionStatus({
      ...input,
      daemonReachable: true,
      activity: await loadActivity(),
    });
  } catch {
    return buildChatSessionStatus({
      ...input,
      daemonReachable: false,
    });
  }
}

export async function queryChatSessionStatus(
  input: ChatSessionStatusQuery,
  request: typeof requestDaemonCommand = requestDaemonCommand,
) {
  return await readChatSessionStatus(input, async () => {
    return await request(
      {
        id: `chat_status_${process.pid}_${Date.now()}`,
        type: "daemon_activity",
      },
      { timeoutMs: CHAT_STATUS_REQUEST_TIMEOUT_MS },
    );
  });
}

export function renderChatSessionStatus(status: ChatSessionStatus) {
  return `Current session: ${status.session}`;
}
