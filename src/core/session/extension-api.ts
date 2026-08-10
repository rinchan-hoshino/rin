import fs from "node:fs";

import type {
  RinChatSessionState,
  RinDaemonSessionAPI,
  RinDaemonSessionRef,
} from "../rin-extension-api.js";
import { loadRinSessionManagerModule } from "../rin-lib/loader.js";
import { sessionActivityState } from "./activity-status.js";
import { resolveStoredSessionFile, toStoredSessionFile } from "./ref.js";

const SESSION_REF_PREFIX = "rin-session-v1:";

type ConversationCacheEntry = {
  fingerprint: string;
  hasConversation: boolean;
};

export function createDaemonSessionRef(
  agentDir: string,
  sessionFile: unknown,
): RinDaemonSessionRef | null {
  const stored = toStoredSessionFile(agentDir, sessionFile);
  if (!stored) return null;
  return {
    token: `${SESSION_REF_PREFIX}${Buffer.from(stored, "utf8").toString("base64url")}`,
  };
}

function resolveDaemonSessionRef(
  agentDir: string,
  ref: RinDaemonSessionRef,
): string {
  const token = String(ref?.token || "").trim();
  if (!token.startsWith(SESSION_REF_PREFIX)) {
    throw new Error("Session reference is invalid or expired.");
  }
  const stored = Buffer.from(
    token.slice(SESSION_REF_PREFIX.length),
    "base64url",
  ).toString("utf8");
  const sessionFile = resolveStoredSessionFile(agentDir, stored);
  if (!sessionFile) {
    throw new Error("Session reference is invalid or expired.");
  }
  return sessionFile;
}

export class SessionConversationReader {
  private readonly cache = new Map<string, ConversationCacheEntry>();

  async hasConversation(sessionFile: string): Promise<boolean> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(sessionFile);
    } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    const fingerprint = [
      stat.dev,
      stat.ino,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
    ].join(":");
    const cached = this.cache.get(sessionFile);
    if (cached?.fingerprint === fingerprint) return cached.hasConversation;

    const { SessionManager } = await loadRinSessionManagerModule();
    const manager = SessionManager.open(sessionFile);
    const hasConversation = manager.buildSessionContext().messages.length > 0;
    if (this.cache.size >= 1_024) this.cache.clear();
    this.cache.set(sessionFile, { fingerprint, hasConversation });
    return hasConversation;
  }
}

export function createDaemonSessionAPI(input: {
  agentDir: string;
  getActivity: () => unknown;
  conversationReader?: SessionConversationReader;
}): RinDaemonSessionAPI {
  const conversationReader =
    input.conversationReader || new SessionConversationReader();
  return {
    async getStates(refs) {
      const activity = input.getActivity();
      return await Promise.all(
        refs.map(async (ref): Promise<RinChatSessionState> => {
          if (!ref) return "idle";
          const sessionFile = resolveDaemonSessionRef(input.agentDir, ref);
          const activityState = sessionActivityState({
            agentDir: input.agentDir,
            daemonReachable: true,
            sessionFile,
            localTurnActive: false,
            activity,
          });
          if (activityState === "working" || activityState === "compacting") {
            return "executing";
          }
          return (await conversationReader.hasConversation(sessionFile))
            ? "waiting"
            : "idle";
        }),
      );
    },
  };
}
