import { requestDaemonCommand } from "../rin-daemon/client.js";
import {
  sessionActivityState,
  type RinSessionActivityState,
} from "../session/activity-status.js";

export type ChatSessionState = RinSessionActivityState;

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

export function buildChatSessionStatus(
  input: ChatSessionStatusInput,
): ChatSessionStatus {
  return { session: sessionActivityState(input) };
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
