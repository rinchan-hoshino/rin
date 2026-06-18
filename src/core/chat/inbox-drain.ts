import type { ChatController } from "./controller.js";
import {
  type ChatInboxItem,
  claimChatInboxFile,
  completeChatInboxFile,
  failChatInboxFile,
  listPendingChatInboxFiles,
  readChatInboxItem,
  requeueChatInboxFile,
  restoreChatInboxFile,
  restoreProcessingChatInboxFiles,
} from "./inbox.js";
import { safeString } from "../text-utils.js";

const CHAT_INBOX_RETRY_MIN_MS = 2000;
const CHAT_INBOX_RETRY_MAX_MS = 60_000;
const CHAT_INBOX_MAX_ATTEMPTS = 5;

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
  const nextAttemptCount = Number(job.envelope.attemptCount || 0) + 1;
  const errorMessage = safeString(error || "chat_inbound_retry_needed");
  if (nextAttemptCount >= CHAT_INBOX_MAX_ATTEMPTS) {
    failChatInboxFile(agentDir, job.claimedPath, job.envelope, errorMessage);
    return;
  }
  requeueChatInboxFile(agentDir, job.claimedPath, job.envelope, {
    delayMs: computeChatInboxRetryDelay(nextAttemptCount),
    error: errorMessage,
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
  processingStaleMs?: number;
  maxProcessingRestorePerDrain?: number;
  maxClaimsPerDrain?: number;
  maxActiveChatKeyWorkers?: number;
  activeChatKeyWorkerCount?: () => number;
  logger?: { warn?: (...args: any[]) => void };
}) {
  const drainChatInboxOnce = async () => {
    const restored = restoreProcessingChatInboxFiles(deps.agentDir, {
      staleMs: deps.processingStaleMs,
      limit: deps.maxProcessingRestorePerDrain,
    });
    if (restored.length) {
      deps.logger?.warn?.(
        `chat inbox restored stale processing items count=${restored.length}`,
      );
    }
    let claimedCount = 0;
    const canClaimMore = () => {
      const maxClaimsPerDrain = Math.max(
        0,
        Number(deps.maxClaimsPerDrain || 0),
      );
      if (maxClaimsPerDrain > 0 && claimedCount >= maxClaimsPerDrain) {
        return false;
      }
      const maxActiveChatKeyWorkers = Math.max(
        0,
        Number(deps.maxActiveChatKeyWorkers || 0),
      );
      const activeChatKeyWorkerCount = deps.activeChatKeyWorkerCount?.() || 0;
      if (
        maxActiveChatKeyWorkers > 0 &&
        activeChatKeyWorkerCount >= maxActiveChatKeyWorkers
      ) {
        return false;
      }
      return true;
    };
    for (const filePath of listPendingChatInboxFiles(deps.agentDir)) {
      if (!canClaimMore()) break;
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
      claimedCount += 1;
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
