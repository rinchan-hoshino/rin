import type { ChatController } from "./controller.js";
import {
  type ChatInboxItem,
  type ClaimedChatInboxItem,
  claimChatInboxItem,
  completeClaimedChatInboxItem,
  failClaimedChatInboxItem,
  listPendingChatInboxItems,
} from "./inbox.js";
import { safeString } from "../text-utils.js";

export type ClaimedChatInboxJob = {
  envelope: ClaimedChatInboxItem;
};

export type ChatInboxJobResult = {
  preserveForRestart?: boolean;
  errorMessage?: string;
  disposition?: "record_only" | "actionable";
  terminalKind?: string;
};

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

export function finalizeClaimedChatInboxJob(
  agentDir: string,
  job: ClaimedChatInboxJob,
  result: ChatInboxJobResult | undefined,
) {
  if (safeString(result?.errorMessage).trim()) {
    throw new Error(safeString(result?.errorMessage));
  }
  return completeClaimedChatInboxJob(agentDir, job, result);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(value && typeof (value as any).then === "function");
}

type ClaimPendingItemResult =
  | "claimed"
  | "consumed"
  | "waitForChat"
  | "unavailable";

function shouldRedrainAfterAsyncAdmissionResult(
  result: ClaimPendingItemResult,
) {
  return result !== "waitForChat";
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
          ? "waitForChat"
          : "unavailable";
      }
      const controller =
        envelope.chatKey === pendingChatKey
          ? pendingController
          : deps.getController(envelope.chatKey);
      if (controller?.ownsInboundMessage?.(envelope.messageId)) {
        failClaimedChatInboxItem(
          deps.agentDir,
          envelope,
          "chat_inbound_still_owned",
        );
        return "unavailable";
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
      const pendingController = deps.getController(pendingChatKey);
      if (activeAdmissionChatKeys.has(pendingChatKey)) continue;
      const chatKeyBlocked = deps.isChatKeyBlocked?.(pendingChatKey) === true;
      if (!deps.hasActiveChatKeyWorker?.(pendingChatKey)) {
        if (chatKeyBlocked) continue;
        const pending = pendingItems[0];
        if (pending) {
          claimPendingItem(pending, pendingController, pendingChatKey);
        }
        continue;
      }
      if (!pendingController?.hasActiveTurn?.()) continue;

      let candidates = prioritizeActiveCandidates(
        pendingItems,
        pendingController,
      );
      if (chatKeyBlocked) {
        if (!deps.isPriorityDuringActiveChatKeyWorker) continue;
        candidates = candidates.filter((pending) =>
          deps.isPriorityDuringActiveChatKeyWorker?.(
            pending,
            pendingController,
          ),
        );
        if (!candidates.length) continue;
      }
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
