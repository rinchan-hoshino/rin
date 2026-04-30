import type { ChatController } from "./controller.js";
import {
  type ChatInboxItem,
  claimChatInboxFile,
  completeChatInboxFile,
  listPendingChatInboxFiles,
  readChatInboxItem,
  requeueChatInboxFile,
  restoreChatInboxFile,
} from "./inbox.js";
import { safeString } from "../text-utils.js";

const CHAT_INBOX_RETRY_MIN_MS = 2000;
const CHAT_INBOX_RETRY_MAX_MS = 60_000;

export type ClaimedChatInboxJob = {
  claimedPath: string;
  envelope: ChatInboxItem;
};

export type ChatInboxJobResult = {
  retry?: boolean;
  errorMessage?: string;
};

export function computeChatInboxRetryDelay(attemptCount: number) {
  const attempt = Math.max(0, Number(attemptCount || 0));
  return Math.min(
    CHAT_INBOX_RETRY_MAX_MS,
    CHAT_INBOX_RETRY_MIN_MS * 2 ** attempt,
  );
}

export function completeClaimedChatInboxJob(job: ClaimedChatInboxJob) {
  completeChatInboxFile(job.claimedPath);
}

export function requeueClaimedChatInboxJob(
  agentDir: string,
  job: ClaimedChatInboxJob,
  error?: unknown,
) {
  requeueChatInboxFile(agentDir, job.claimedPath, job.envelope, {
    delayMs: computeChatInboxRetryDelay(job.envelope.attemptCount + 1),
    error: safeString(error || "chat_inbound_retry_needed"),
  });
}

export function finalizeClaimedChatInboxJob(
  agentDir: string,
  job: ClaimedChatInboxJob,
  result: ChatInboxJobResult | undefined,
) {
  if (result?.retry) {
    requeueClaimedChatInboxJob(
      agentDir,
      job,
      result.errorMessage || "chat_inbound_retry_needed",
    );
    return;
  }
  completeClaimedChatInboxJob(job);
}

export function createChatInboxDrain(deps: {
  agentDir: string;
  getController: (chatKey: string) => ChatController;
  isInboundMessageProcessed: (chatKey: string, messageId: string) => boolean;
  enqueueClaimedInboxItem: (job: ClaimedChatInboxJob) => void;
  logger?: { warn?: (...args: any[]) => void };
}) {
  const drainChatInboxOnce = async () => {
    for (const filePath of listPendingChatInboxFiles(deps.agentDir)) {
      let claimedPath = "";
      try {
        claimedPath = claimChatInboxFile(deps.agentDir, filePath);
      } catch {
        continue;
      }
      if (!claimedPath) continue;
      const envelope = readChatInboxItem(claimedPath);
      if (!envelope) {
        completeChatInboxFile(claimedPath);
        continue;
      }
      const nextAttemptAt = Date.parse(
        safeString(envelope.nextAttemptAt || "").trim(),
      );
      if (Number.isFinite(nextAttemptAt) && nextAttemptAt > Date.now()) {
        restoreChatInboxFile(deps.agentDir, claimedPath, envelope);
        continue;
      }
      const controller = envelope.chatKey
        ? deps.getController(envelope.chatKey)
        : null;
      if (controller?.claimsInboundMessage(envelope.messageId)) {
        completeChatInboxFile(claimedPath);
        continue;
      }
      if (
        deps.isInboundMessageProcessed(envelope.chatKey, envelope.messageId)
      ) {
        completeChatInboxFile(claimedPath);
        continue;
      }
      deps.enqueueClaimedInboxItem({ claimedPath, envelope });
    }
  };

  let inboxDrainRunning = false;
  let inboxDrainRequested = false;
  const requestDrainChatInbox = () => {
    inboxDrainRequested = true;
    if (inboxDrainRunning) return;
    inboxDrainRunning = true;
    void (async () => {
      try {
        while (inboxDrainRequested) {
          inboxDrainRequested = false;
          await drainChatInboxOnce();
        }
      } catch (error: any) {
        deps.logger?.warn?.(
          `chat inbox drain failed err=${safeString(error?.message || error)}`,
        );
      } finally {
        inboxDrainRunning = false;
        if (inboxDrainRequested) requestDrainChatInbox();
      }
    })();
  };

  return {
    requestDrainChatInbox,
    drainChatInboxOnce,
  };
}
