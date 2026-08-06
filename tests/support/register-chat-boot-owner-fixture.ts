import { register } from "node:module";

const target = "/dist/core/chat/boot.js";
const hookSource = `
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(${JSON.stringify(target)})) return loaded;
  return {
    ...loaded,
    source: String(loaded.source) + "\\nexport { normalizePositiveMilliseconds as __rinOwnerNormalizePositiveMilliseconds, isRetryDue as __rinOwnerIsRetryDue, isOutboxItemExpired as __rinOwnerIsOutboxItemExpired, isOutboxItemDrainable as __rinOwnerIsOutboxItemDrainable, isSameSendingAttempt as __rinOwnerIsSameSendingAttempt, withChatOutboxSendTimeout as __rinOwnerWithChatOutboxSendTimeout, deliveredChatOutboxItem as __rinOwnerDeliveredChatOutboxItem, deliveredUnconfirmedChatOutboxItem as __rinOwnerDeliveredUnconfirmedChatOutboxItem, failedChatOutboxItem as __rinOwnerFailedChatOutboxItem, queuedChatOutboxItem as __rinOwnerQueuedChatOutboxItem, settleChatOutboxFailure as __rinOwnerSettleChatOutboxFailure };\\n",
    shortCircuit: true,
  };
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
