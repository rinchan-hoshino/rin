import { createHash } from "node:crypto";

import { safeString } from "../text-utils.js";
import {
  enqueueChatOutboxPayload,
  normalizeChatOutboxPayload,
  type ChatOutboxDeliveryKind,
  type EnqueueChatOutboxOptions,
  type ChatOutboxPayload,
  type ChatOutboxTurnFence,
} from "../rin-lib/chat-outbox.js";
import { openChatDatabase } from "./database.js";

export type CanonicalChatRunFence = {
  runId: string;
  ownerEpoch: string;
  producerIncarnation: string;
};

export type CanonicalChatRun = CanonicalChatRunFence & {
  chatKey: string;
  generation: number;
  deliveryTurnId: string;
};

function requiredText(value: unknown, error: string) {
  const text = safeString(value).trim();
  if (!text) throw new Error(error);
  return text;
}

function readRunningTurn(agentDir: string, turnFence: ChatOutboxTurnFence) {
  const db = openChatDatabase(agentDir);
  return db
    .prepare(
      `SELECT turns.turn_id, turns.chat_key, turns.generation,
              turns.owner_epoch, turns.attempt, turns.run_id,
              messages.message_id
         FROM turns
         JOIN messages ON messages.id = turns.inbound_message_id
        WHERE turns.turn_id = ? AND turns.chat_key = ?
          AND turns.state = 'running'`,
    )
    .get(turnFence.turnId, turnFence.chatKey) as
    | {
        turn_id: string;
        chat_key: string;
        generation: number;
        owner_epoch: string | null;
        attempt: number;
        run_id: string | null;
        message_id: string;
      }
    | undefined;
}

function assertTurnFence(
  row: ReturnType<typeof readRunningTurn>,
  turnFence: ChatOutboxTurnFence,
) {
  if (
    !row ||
    row.owner_epoch !== turnFence.ownerEpoch ||
    row.attempt !== turnFence.attempt ||
    row.message_id !== turnFence.messageId
  ) {
    throw new Error("chat_run_stale_turn");
  }
}

export function createCanonicalChatRun(
  agentDir: string,
  input: {
    turnFence: ChatOutboxTurnFence;
    producerIncarnation: string;
  },
): CanonicalChatRun {
  const db = openChatDatabase(agentDir);
  const turnFence = input.turnFence;
  const producerIncarnation = requiredText(
    input.producerIncarnation,
    "chat_run_missing_producer_incarnation",
  );
  const runId = requiredText(turnFence.turnId, "chat_run_missing_id");
  return db
    .transaction(() => {
      const turn = readRunningTurn(agentDir, turnFence);
      assertTurnFence(turn, turnFence);
      if (turn!.run_id && turn!.run_id !== runId) {
        throw new Error("chat_run_turn_already_attached");
      }
      const existing = db
        .prepare(
          `SELECT run_id, chat_key, generation, owner_epoch,
                producer_incarnation, delivery_turn_id
           FROM chat_runs WHERE run_id = ?`,
        )
        .get(runId) as
        | {
            run_id: string;
            chat_key: string;
            generation: number;
            owner_epoch: string;
            producer_incarnation: string;
            delivery_turn_id: string;
          }
        | undefined;
      if (existing) {
        if (
          existing.owner_epoch !== turnFence.ownerEpoch ||
          existing.producer_incarnation !== producerIncarnation ||
          existing.delivery_turn_id !== turnFence.turnId
        ) {
          throw new Error("chat_run_identity_conflict");
        }
      } else {
        const timestamp = new Date().toISOString();
        db.prepare(
          `INSERT INTO chat_runs (
           run_id, chat_key, generation, state, owner_epoch,
           producer_incarnation, delivery_turn_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
        ).run(
          runId,
          turn!.chat_key,
          turn!.generation,
          turnFence.ownerEpoch,
          producerIncarnation,
          turnFence.turnId,
          timestamp,
          timestamp,
        );
        db.prepare(`UPDATE turns SET run_id = ? WHERE turn_id = ?`).run(
          runId,
          turnFence.turnId,
        );
      }
      return {
        runId,
        chatKey: turn!.chat_key,
        generation: turn!.generation,
        ownerEpoch: turnFence.ownerEpoch,
        producerIncarnation,
        deliveryTurnId: turnFence.turnId,
      };
    })
    .immediate();
}

export function loadCanonicalChatRunForRecovery(
  agentDir: string,
  fence: CanonicalChatRunFence,
  options: { terminalStagedAt?: string } = {},
):
  | {
      run: CanonicalChatRun;
      turn: {
        incomingMessageId: string;
        replyToMessageId: string;
        outboxTurnFence: ChatOutboxTurnFence;
      };
    }
  | undefined {
  const db = openChatDatabase(agentDir);
  const terminalStagedAt = String(options.terminalStagedAt || "").trim();
  const row = db
    .prepare(
      terminalStagedAt
        ? `SELECT runs.run_id, runs.chat_key, runs.generation, runs.state,
                  runs.owner_epoch, runs.producer_incarnation,
                  turns.turn_id AS delivery_turn_id,
                  turns.owner_epoch AS turn_owner_epoch,
                  turns.attempt, messages.message_id
             FROM chat_runs AS runs
             JOIN turns ON turns.run_id = runs.run_id
             JOIN messages ON messages.id = turns.inbound_message_id
            WHERE runs.run_id = ? AND turns.state = 'running'
              AND turns.created_at <= ?
            ORDER BY turns.sequence DESC
            LIMIT 1`
        : `SELECT runs.run_id, runs.chat_key, runs.generation, runs.state,
                  runs.owner_epoch, runs.producer_incarnation,
                  runs.delivery_turn_id, turns.owner_epoch AS turn_owner_epoch,
                  turns.attempt, messages.message_id
             FROM chat_runs AS runs
             JOIN turns ON turns.turn_id = runs.delivery_turn_id
             JOIN messages ON messages.id = turns.inbound_message_id
            WHERE runs.run_id = ?`,
    )
    .get(
      ...(terminalStagedAt ? [fence.runId, terminalStagedAt] : [fence.runId]),
    ) as
    | {
        run_id: string;
        chat_key: string;
        generation: number;
        state: string;
        owner_epoch: string;
        producer_incarnation: string;
        delivery_turn_id: string;
        turn_owner_epoch: string;
        attempt: number;
        message_id: string;
      }
    | undefined;
  if (!row) return;
  if (
    row.owner_epoch !== fence.ownerEpoch ||
    row.producer_incarnation !== fence.producerIncarnation
  ) {
    throw new Error("chat_run_stale_producer");
  }
  if (!["running", "draining", "terminal"].includes(row.state)) {
    throw new Error("chat_run_not_recoverable");
  }
  return {
    run: {
      runId: row.run_id,
      chatKey: row.chat_key,
      generation: row.generation,
      ownerEpoch: row.owner_epoch,
      producerIncarnation: row.producer_incarnation,
      deliveryTurnId: row.delivery_turn_id,
    },
    turn: {
      incomingMessageId: row.message_id,
      replyToMessageId: row.message_id,
      outboxTurnFence: {
        agentDir,
        turnId: row.delivery_turn_id,
        chatKey: row.chat_key,
        messageId: row.message_id,
        ownerEpoch: row.turn_owner_epoch,
        attempt: row.attempt,
      },
    },
  };
}

export function attachChatTurnToRun(
  agentDir: string,
  input: CanonicalChatRunFence & { turnFence: ChatOutboxTurnFence },
) {
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const run = db
        .prepare(
          `SELECT run_id, chat_key, state, owner_epoch, producer_incarnation
           FROM chat_runs WHERE run_id = ?`,
        )
        .get(input.runId) as
        | {
            run_id: string;
            chat_key: string;
            state: string;
            owner_epoch: string;
            producer_incarnation: string;
          }
        | undefined;
      if (
        !run ||
        run.state !== "running" ||
        run.owner_epoch !== input.ownerEpoch ||
        run.producer_incarnation !== input.producerIncarnation
      ) {
        throw new Error("chat_run_stale_producer");
      }
      const turn = readRunningTurn(agentDir, input.turnFence);
      assertTurnFence(turn, input.turnFence);
      if (turn!.chat_key !== run.chat_key) {
        throw new Error("chat_run_chat_mismatch");
      }
      if (turn!.run_id && turn!.run_id !== input.runId) {
        throw new Error("chat_run_turn_already_attached");
      }
      const timestamp = new Date().toISOString();
      db.prepare(
        `UPDATE turns SET run_id = ?, updated_at = ? WHERE turn_id = ?`,
      ).run(input.runId, timestamp, input.turnFence.turnId);
      db.prepare(
        `UPDATE chat_runs
          SET delivery_turn_id = ?, updated_at = ?
        WHERE run_id = ? AND state = 'running'
          AND owner_epoch = ? AND producer_incarnation = ?`,
      ).run(
        input.turnFence.turnId,
        timestamp,
        input.runId,
        input.ownerEpoch,
        input.producerIncarnation,
      );
      return { runId: input.runId, deliveryTurnId: input.turnFence.turnId };
    })
    .immediate();
}

export function commitCanonicalChatRunTerminal(
  agentDir: string,
  fence: CanonicalChatRunFence,
  payload: ChatOutboxPayload,
  options: {
    deliveryKind: Extract<ChatOutboxDeliveryKind, "final" | "error">;
    terminalStagedAt?: string;
    enqueueOptions?: Omit<
      EnqueueChatOutboxOptions,
      "deliveryKind" | "idempotencyKey" | "turnFence"
    >;
  },
): { status: "committed" | "duplicate"; outboxId: string } {
  const normalizedPayload = normalizeChatOutboxPayload(payload);
  if (!normalizedPayload) throw new Error("chat_run_invalid_terminal_payload");
  const terminalJson = JSON.stringify({
    deliveryKind: options.deliveryKind,
    payload: normalizedPayload,
  });
  const terminalHash = createHash("sha256").update(terminalJson).digest("hex");
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const run = db
        .prepare(
          `SELECT run_id, chat_key, state, owner_epoch, producer_incarnation,
                delivery_turn_id, terminal_payload_hash
           FROM chat_runs WHERE run_id = ?`,
        )
        .get(fence.runId) as
        | {
            run_id: string;
            chat_key: string;
            state: string;
            owner_epoch: string;
            producer_incarnation: string;
            delivery_turn_id: string;
            terminal_payload_hash: string | null;
          }
        | undefined;
      if (!run) throw new Error("chat_run_missing");
      if (
        run.owner_epoch !== fence.ownerEpoch ||
        run.producer_incarnation !== fence.producerIncarnation
      ) {
        throw new Error("chat_run_stale_producer");
      }
      if (run.state === "terminal") {
        if (run.terminal_payload_hash !== terminalHash) {
          throw new Error("chat_run_terminal_conflict");
        }
        const existing = db
          .prepare(`SELECT outbox_id FROM outbox WHERE idempotency_key = ?`)
          .get(`terminal:${fence.runId}`) as { outbox_id: string } | undefined;
        if (!existing) throw new Error("chat_run_terminal_outbox_missing");
        return { status: "duplicate" as const, outboxId: existing.outbox_id };
      }
      if (run.state !== "running" && run.state !== "draining") {
        throw new Error("chat_run_not_terminalizable");
      }
      const terminalStagedAt = String(options.terminalStagedAt || "").trim();
      const eligibleDeliveryTurnId = terminalStagedAt
        ? (
            db
              .prepare(
                `SELECT turn_id
                   FROM turns
                  WHERE run_id = ? AND state = 'running' AND created_at <= ?
                  ORDER BY sequence DESC
                  LIMIT 1`,
              )
              .get(fence.runId, terminalStagedAt) as
              | { turn_id?: string }
              | undefined
          )?.turn_id
        : run.delivery_turn_id;
      const deliveryTurn = db
        .prepare(
          `SELECT turns.turn_id, turns.chat_key, turns.owner_epoch, turns.attempt,
                messages.message_id
           FROM turns
           JOIN messages ON messages.id = turns.inbound_message_id
          WHERE turns.turn_id = ? AND turns.run_id = ?
            AND turns.state = 'running'`,
        )
        .get(eligibleDeliveryTurnId, fence.runId) as
        | {
            turn_id: string;
            chat_key: string;
            owner_epoch: string;
            attempt: number;
            message_id: string;
          }
        | undefined;
      if (!deliveryTurn) throw new Error("chat_run_delivery_turn_missing");
      const timestamp = new Date().toISOString();
      const outboxId = enqueueChatOutboxPayload(agentDir, normalizedPayload, {
        ...options.enqueueOptions,
        deliveryKind: options.deliveryKind,
        idempotencyKey: `terminal:${fence.runId}`,
        turnFence: {
          agentDir,
          turnId: deliveryTurn.turn_id,
          chatKey: deliveryTurn.chat_key,
          messageId: deliveryTurn.message_id,
          ownerEpoch: deliveryTurn.owner_epoch,
          attempt: deliveryTurn.attempt,
        },
      });
      if (terminalStagedAt) {
        db.prepare(
          `UPDATE turns
              SET state = 'failed', owner_epoch = NULL,
                  lease_until = NULL, heartbeat_at = NULL,
                  next_attempt_at = NULL,
                  last_error = 'chat_run_terminal_precedes_turn',
                  terminal_kind = 'run_terminal_precedes_turn',
                  updated_at = ?
            WHERE run_id = ? AND state = 'running' AND created_at > ?`,
        ).run(timestamp, fence.runId, terminalStagedAt);
      }
      db.prepare(
        `UPDATE turns
          SET state = 'superseded', terminal_kind = 'run_superseded',
              lease_until = NULL, heartbeat_at = NULL, next_attempt_at = NULL,
              last_error = NULL, updated_at = ?
        WHERE run_id = ? AND turn_id <> ?
          AND state IN ('pending', 'running')`,
      ).run(timestamp, fence.runId, deliveryTurn.turn_id);
      const changed = db
        .prepare(
          `UPDATE chat_runs
            SET state = 'terminal',
                delivery_turn_id = ?, terminal_delivery_turn_id = ?,
                terminal_kind = ?, terminal_payload_json = ?,
                terminal_payload_hash = ?, terminal_at = ?, updated_at = ?
          WHERE run_id = ? AND state IN ('running', 'draining')
            AND owner_epoch = ? AND producer_incarnation = ?`,
        )
        .run(
          deliveryTurn.turn_id,
          deliveryTurn.turn_id,
          options.deliveryKind,
          terminalJson,
          terminalHash,
          timestamp,
          timestamp,
          fence.runId,
          fence.ownerEpoch,
          fence.producerIncarnation,
        );
      if (!changed.changes) throw new Error("chat_run_terminal_fence_lost");
      return { status: "committed" as const, outboxId };
    })
    .immediate();
}
