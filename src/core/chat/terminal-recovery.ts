import {
  commitChatTerminalWal,
  listStagedChatTerminalWal,
  quarantineChatTerminalWal,
} from "../rin-daemon/chat-terminal-wal.js";
import { withChatQuotePart } from "../rin-lib/chat-outbox.js";
import { toStoredSessionFile } from "../session/ref.js";
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
  let quarantined = 0;
  const stagedRecords = listStagedChatTerminalWal(agentDir);
  const quarantine = (
    record: (typeof stagedRecords)[number],
    reason: string,
  ) => {
    quarantineChatTerminalWal(agentDir, {
      runId: record.runId,
      ownerEpoch: record.ownerEpoch,
      producerIncarnation: record.producerIncarnation,
      payloadHash: record.payloadHash,
      reason,
    });
    quarantined += 1;
  };
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
      quarantine(record, "chat_terminal_recovery_target_missing");
      continue;
    }
    let delivery: ReturnType<typeof terminalDelivery>;
    try {
      delivery = terminalDelivery(record);
    } catch (error: any) {
      quarantine(
        record,
        safeString(error?.message).trim() ||
          "chat_terminal_recovery_invalid_payload",
      );
      continue;
    }
    if (!delivery.text) {
      quarantine(record, "chat_terminal_recovery_text_missing");
      continue;
    }
    let sessionFile: string;
    try {
      sessionFile = safeString(recovered.turn.executionSessionFile).trim();
      if (!sessionFile) {
        if (
          typeof record.terminalPayload.sessionFile !== "string" ||
          !record.terminalPayload.sessionFile.trim()
        ) {
          throw new Error("chat_terminal_recovery_invalid_session_file");
        }
        sessionFile = toStoredSessionFile(
          agentDir,
          record.terminalPayload.sessionFile,
        );
        if (!sessionFile) {
          throw new Error("chat_terminal_recovery_invalid_session_file");
        }
      }
    } catch {
      quarantine(record, "chat_terminal_recovery_invalid_session_file");
      continue;
    }
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
  return { committed, quarantined };
}
