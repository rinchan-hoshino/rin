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
  isChatKeyBlocked?: (chatKey: string) => boolean;
  hasActiveChatKeyWorker?: (chatKey: string) => boolean;
  canClaimDuringActiveChatKeyWorker?: (
    envelope: ChatInboxItem,
    controller: ChatController,
  ) => boolean | Promise<boolean>;
  isPriorityDuringActiveChatKeyWorker?: (
    envelope: ChatInboxItem,
    controller: ChatController,
  ) => boolean;
  logger?: { warn?: (...args: any[]) => void };
}) {
  const activeAdmissionChatKeys = new Set<string>();
  let requestDrainChatInbox: () => void = () => {};

  const drainChatInboxOnce = async () => {
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
      return "claimed";
    };

    const prioritizeActiveCandidates = (
      pendingItems: ChatInboxItem[],
      controller: ChatController,
    ) => {
      if (!deps.isPriorityDuringActiveChatKeyWorker) return pendingItems;
      const priority: ChatInboxItem[] = [];
      const ordinary: ChatInboxItem[] = [];
      for (const pending of pendingItems) {
        (deps.isPriorityDuringActiveChatKeyWorker(pending, controller)
          ? priority
          : ordinary
        ).push(pending);
      }
      return [...priority, ...ordinary];
    };

    const scheduleAsyncBusyAdmission = (
      pendingItems: ChatInboxItem[],
      pendingController: ChatController,
      pendingChatKey: string,
      firstAdmission: Promise<boolean>,
    ) => {
      activeAdmissionChatKeys.add(pendingChatKey);
      let shouldRequestDrainAfterAdmission = false;
      void (async () => {
        for (let index = 0; index < pendingItems.length; index += 1) {
          const pending = pendingItems[index]!;
          const canClaim =
            index === 0
              ? await firstAdmission
              : await deps.canClaimDuringActiveChatKeyWorker?.(
                  pending,
                  pendingController,
                );
          if (!canClaim) continue;
          const result = claimPendingItem(
            pending,
            pendingController,
            pendingChatKey,
          );
          if (result === "unavailable") continue;
          return result;
        }
        return null;
      })()
        .then((result) => {
          if (result !== null) {
            shouldRequestDrainAfterAdmission =
              shouldRedrainAfterAsyncAdmissionResult(result);
          }
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

    const pendingByChatKey = new Map<string, ChatInboxItem[]>();
    for (const pending of listPendingChatInboxItems(deps.agentDir)) {
      const items = pendingByChatKey.get(pending.chatKey) || [];
      items.push(pending);
      pendingByChatKey.set(pending.chatKey, items);
    }

    for (const [pendingChatKey, pendingItems] of pendingByChatKey) {
      if (deps.isChatKeyBlocked?.(pendingChatKey)) continue;
      const pendingController = deps.getController(pendingChatKey);
      if (activeAdmissionChatKeys.has(pendingChatKey)) continue;
      if (!deps.hasActiveChatKeyWorker?.(pendingChatKey)) {
        const pending = pendingItems[0];
        if (pending) {
          claimPendingItem(pending, pendingController, pendingChatKey);
        }
        continue;
      }
      if (!pendingController?.hasActiveTurn?.()) continue;

      const candidates = prioritizeActiveCandidates(
        pendingItems,
        pendingController,
      );
      for (let index = 0; index < candidates.length; index += 1) {
        const pending = candidates[index]!;
        const admission = deps.canClaimDuringActiveChatKeyWorker?.(
          pending,
          pendingController,
        );
        if (isPromiseLike(admission)) {
          scheduleAsyncBusyAdmission(
            candidates.slice(index),
            pendingController,
            pendingChatKey,
            admission,
          );
          break;
        }
        if (!admission) continue;
        const result = claimPendingItem(
          pending,
          pendingController,
          pendingChatKey,
        );
        if (result !== "unavailable") break;
      }
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
