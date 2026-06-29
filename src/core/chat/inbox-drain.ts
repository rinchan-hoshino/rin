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
} from "./inbox.js";
import { parseChatKey } from "./support.js";
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
  suppressRetryNotice?: boolean;
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

function invalidChatKeyError(chatKey: string) {
  return `invalid_chatKey:${safeString(chatKey).trim()}`;
}

export function createChatInboxDrain(deps: {
  agentDir: string;
  getController: (chatKey: string) => ChatController;
  isInboundMessageProcessed: (chatKey: string, messageId: string) => boolean;
  enqueueClaimedInboxItem: (job: ClaimedChatInboxJob) => void;
  hasActiveChatKeyWorker?: (chatKey: string) => boolean;
  canClaimDuringActiveChatKeyWorker?: (
    envelope: ChatInboxItem,
    controller: ChatController,
  ) => boolean | Promise<boolean>;
  logger?: { warn?: (...args: any[]) => void };
}) {
  const drainChatInboxOnce = async () => {
    const claimedChatKeys = new Set<string>();
    for (const filePath of listPendingChatInboxFiles(deps.agentDir)) {
      const pendingEnvelope = readChatInboxItem(filePath);
      if (!pendingEnvelope) {
        completeChatInboxFile(filePath);
        continue;
      }
      const pendingChatKey = safeString(pendingEnvelope.chatKey || "").trim();
      if (!pendingChatKey || !parseChatKey(pendingChatKey)) {
        failChatInboxFile(
          deps.agentDir,
          filePath,
          pendingEnvelope,
          invalidChatKeyError(pendingChatKey),
        );
        continue;
      }
      const pendingController = deps.getController(pendingChatKey);
      const hasBusyChatKey = Boolean(
        claimedChatKeys.has(pendingChatKey) ||
        deps.hasActiveChatKeyWorker?.(pendingChatKey),
      );
      const canClaimBusyChatKey = hasBusyChatKey
        ? Boolean(
            (pendingController as any)?.hasActiveTurn?.() &&
            (await deps.canClaimDuringActiveChatKeyWorker?.(
              pendingEnvelope,
              pendingController,
            )),
          )
        : true;
      if (!canClaimBusyChatKey) continue;
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
      const envelopeChatKey = safeString(envelope.chatKey || "").trim();
      if (!envelopeChatKey || !parseChatKey(envelopeChatKey)) {
        failChatInboxFile(
          deps.agentDir,
          claimedPath,
          envelope,
          invalidChatKeyError(envelopeChatKey),
        );
        continue;
      }
      const nextAttemptAt = Date.parse(
        safeString(envelope.nextAttemptAt || "").trim(),
      );
      if (Number.isFinite(nextAttemptAt) && nextAttemptAt > Date.now()) {
        restoreChatInboxFile(deps.agentDir, claimedPath, envelope);
        continue;
      }
      const controller =
        envelope.chatKey && envelope.chatKey === pendingChatKey
          ? pendingController
          : envelope.chatKey
            ? deps.getController(envelope.chatKey)
            : null;
      if (controller?.ownsInboundMessage?.(envelope.messageId)) {
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
      claimedChatKeys.add(envelope.chatKey);
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
