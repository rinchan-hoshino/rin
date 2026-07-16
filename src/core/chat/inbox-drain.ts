import type { ChatController } from "./controller.js";
import {
  type ChatInboxItem,
  type ClaimedChatInboxItem,
  claimChatInboxItem,
  completeClaimedChatInboxItem,
  failClaimedChatInboxItem,
  isChatInboxItemAccepted,
  listPendingChatInboxItems,
  requeueClaimedChatInboxItem,
} from "./inbox.js";
import { safeString } from "../text-utils.js";

const CHAT_INBOX_RETRY_MIN_MS = 2000;
const CHAT_INBOX_RETRY_MAX_MS = 60_000;
const CHAT_INBOX_MAX_ATTEMPTS = 5;

export type ClaimedChatInboxJob = {
  envelope: ClaimedChatInboxItem;
};

export type ChatInboxJobResult = {
  retry?: boolean;
  errorMessage?: string;
  disposition?: "record_only" | "actionable" | "superseded";
  terminalKind?: string;
};

export function computeChatInboxRetryDelay(attemptCount: number) {
  const attempt = Math.max(0, Number(attemptCount || 0));
  return Math.min(
    CHAT_INBOX_RETRY_MAX_MS,
    CHAT_INBOX_RETRY_MIN_MS * 2 ** attempt,
  );
}

export function completeClaimedChatInboxJob(
  agentDir: string,
  job: ClaimedChatInboxJob,
  result: ChatInboxJobResult = {},
) {
  return completeClaimedChatInboxItem(agentDir, job.envelope, {
    terminalKind: result.terminalKind,
    disposition: result.disposition,
  });
}

export function requeueClaimedChatInboxJob(
  agentDir: string,
  job: ClaimedChatInboxJob,
  error?: unknown,
) {
  const nextAttemptCount = Number(job.envelope.attemptCount || 0);
  const errorMessage = safeString(error || "chat_inbound_retry_needed");
  if (
    nextAttemptCount >= CHAT_INBOX_MAX_ATTEMPTS &&
    !isChatInboxItemAccepted(agentDir, job.envelope.itemId)
  ) {
    return failClaimedChatInboxItem(agentDir, job.envelope, errorMessage);
  }
  return requeueClaimedChatInboxItem(agentDir, job.envelope, {
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
    return requeueClaimedChatInboxJob(
      agentDir,
      job,
      result.errorMessage || "chat_inbound_retry_needed",
    );
  }
  return completeClaimedChatInboxJob(agentDir, job, result);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value && typeof (value as any).then === "function");
}

type ClaimPendingItemResult =
  | "claimed"
  | "consumed"
  | "retryLater"
  | "unavailable";

function shouldRedrainAfterAsyncAdmissionResult(
  result: ClaimPendingItemResult,
) {
  return result !== "retryLater";
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
  const activeAdmissionChatKeys = new Set<string>();
  let requestDrainChatInbox: () => void = () => {};

  const drainChatInboxOnce = async () => {
    const claimedChatKeys = new Set<string>();

    const claimPendingItem = (
      pending: ChatInboxItem,
      pendingController: ChatController,
      pendingChatKey: string,
    ): ClaimPendingItemResult => {
      const envelope = claimChatInboxItem(deps.agentDir, pending.itemId);
      if (!envelope) {
        const dueAt = Date.parse(safeString(pending.nextAttemptAt).trim());
        return Number.isFinite(dueAt) && dueAt > Date.now()
          ? "retryLater"
          : "unavailable";
      }
      const controller =
        envelope.chatKey === pendingChatKey
          ? pendingController
          : deps.getController(envelope.chatKey);
      if (controller?.ownsInboundMessage?.(envelope.messageId)) {
        requeueClaimedChatInboxItem(deps.agentDir, envelope, {
          delayMs: CHAT_INBOX_RETRY_MIN_MS,
          error: "chat_inbound_still_owned",
        });
        return "retryLater";
      }
      if (
        deps.isInboundMessageProcessed(envelope.chatKey, envelope.messageId)
      ) {
        completeClaimedChatInboxItem(deps.agentDir, envelope, {
          terminalKind: "already_processed",
          disposition: "actionable",
        });
        return "consumed";
      }
      deps.enqueueClaimedInboxItem({ envelope });
      claimedChatKeys.add(envelope.chatKey);
      return "claimed";
    };

    const scheduleAsyncBusyAdmission = (
      pending: ChatInboxItem,
      pendingController: ChatController,
      pendingChatKey: string,
      admission: Promise<boolean>,
    ) => {
      claimedChatKeys.add(pendingChatKey);
      activeAdmissionChatKeys.add(pendingChatKey);
      let shouldRequestDrainAfterAdmission = false;
      void admission
        .then((canClaim) => {
          if (!canClaim) return;
          shouldRequestDrainAfterAdmission =
            shouldRedrainAfterAsyncAdmissionResult(
              claimPendingItem(pending, pendingController, pendingChatKey),
            );
        })
        .catch((error: any) => {
          deps.logger?.warn?.(
            `chat inbox active admission failed chatKey=${pendingChatKey} err=${safeString(error?.message || error)}`,
          );
        })
        .finally(() => {
          activeAdmissionChatKeys.delete(pendingChatKey);
          if (shouldRequestDrainAfterAdmission) requestDrainChatInbox();
        });
    };

    for (const pendingEnvelope of listPendingChatInboxItems(deps.agentDir)) {
      const pendingChatKey = pendingEnvelope.chatKey;
      const pendingController = deps.getController(pendingChatKey);
      const hasBusyChatKey = Boolean(
        claimedChatKeys.has(pendingChatKey) ||
        activeAdmissionChatKeys.has(pendingChatKey) ||
        deps.hasActiveChatKeyWorker?.(pendingChatKey),
      );
      if (hasBusyChatKey) {
        if (activeAdmissionChatKeys.has(pendingChatKey)) continue;
        if (!(pendingController as any)?.hasActiveTurn?.()) continue;
        const admission = deps.canClaimDuringActiveChatKeyWorker?.(
          pendingEnvelope,
          pendingController,
        );
        if (isPromiseLike(admission)) {
          scheduleAsyncBusyAdmission(
            pendingEnvelope,
            pendingController,
            pendingChatKey,
            admission,
          );
          continue;
        }
        if (!admission) continue;
      }
      claimPendingItem(pendingEnvelope, pendingController, pendingChatKey);
    }
  };

  let inboxDrainRunning = false;
  let inboxDrainRequested = false;
  requestDrainChatInbox = () => {
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

  return { requestDrainChatInbox, drainChatInboxOnce };
}
