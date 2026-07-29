import {
  commitChatTerminalWal,
  listStagedChatTerminalWal,
} from "../rin-daemon/chat-terminal-wal.js";
import { withChatQuotePart } from "../rin-lib/chat-outbox.js";
import { safeString } from "../text-utils.js";
import {
  commitCanonicalChatRunTerminal,
  loadCanonicalChatRunForRecovery,
} from "./run-store.js";

function terminalDelivery(
  record: ReturnType<typeof listStagedChatTerminalWal>[number],
) {
  const event = safeString(record.terminalPayload.event).trim();
  if (event === "complete") {
    return {
      deliveryKind: "final" as const,
      text: safeString(record.terminalPayload.finalText).trim(),
    };
  }
  if (event === "error") {
    return {
      deliveryKind: "error" as const,
      text:
        safeString(record.terminalPayload.error).trim() || "rin_turn_failed",
    };
  }
  throw new Error(`chat_terminal_recovery_invalid_event:${event || "unknown"}`);
}

export function reconcileStagedCanonicalChatTerminals(agentDir: string) {
  let committed = 0;
  const stagedRecords = listStagedChatTerminalWal(agentDir);
  for (const record of stagedRecords) {
    const recovered = loadCanonicalChatRunForRecovery(
      agentDir,
      {
        runId: record.runId,
        ownerEpoch: record.ownerEpoch,
        producerIncarnation: record.producerIncarnation,
      },
      { terminalStagedAt: record.stagedAt },
    );
    if (!recovered) {
      throw new Error(`chat_terminal_recovery_target_missing:${record.runId}`);
    }
    const delivery = terminalDelivery(record);
    if (!delivery.text) {
      throw new Error(`chat_terminal_recovery_text_missing:${record.runId}`);
    }
    const sessionFile = safeString(record.terminalPayload.sessionFile).trim();
    const outcome = commitCanonicalChatRunTerminal(
      agentDir,
      {
        runId: record.runId,
        ownerEpoch: record.ownerEpoch,
        producerIncarnation: record.producerIncarnation,
      },
      {
        createdAt: record.stagedAt,
        chatKey: recovered.run.chatKey,
        deliveryKind: delivery.deliveryKind,
        parts: withChatQuotePart(
          [{ type: "text", text: delivery.text }],
          recovered.turn.replyToMessageId,
        ),
        ...(sessionFile ? { sessionFile } : {}),
      },
      {
        deliveryKind: delivery.deliveryKind,
        terminalStagedAt: record.stagedAt,
        enqueueOptions: {
          postDelivery: {
            markProcessed: {
              chatKey: recovered.run.chatKey,
              messageId: recovered.turn.incomingMessageId,
              ...(sessionFile ? { sessionFile } : {}),
              bindSession: Boolean(sessionFile),
            },
          },
        },
      },
    );
    commitChatTerminalWal(agentDir, {
      runId: record.runId,
      ownerEpoch: record.ownerEpoch,
      producerIncarnation: record.producerIncarnation,
      payloadHash: record.payloadHash,
      outboxId: outcome.outboxId,
    });
    committed += 1;
  }
  return { committed, skipped: 0 };
}
