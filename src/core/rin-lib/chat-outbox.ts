import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

import { openChatDatabase } from "../chat/database.js";
import { validateChatOutboxPayloadParts } from "../chat/outbox-payload-validation.js";
import { safeString } from "../text-utils.js";

export type ChatMessagePart =
  | { type: "text"; text: string }
  | { type: "markdown"; text: string }
  | { type: "at"; id: string; name?: string }
  | { type: "quote"; id: string }
  | { type: "image"; path?: string; url?: string; mimeType?: string }
  | {
      type: "file";
      path?: string;
      url?: string;
      name?: string;
      mimeType?: string;
    }
  | {
      type: "video" | "audio" | "sticker";
      path?: string;
      url?: string;
      name?: string;
      mimeType?: string;
    }
  | {
      type: "todo";
      title?: string;
      items: Array<{ text: string; done?: boolean }>;
    };

export type ChatDeliveryKind = "final" | "interim" | "passive_notice" | "error";

export type ChatOutboxPayload = {
  createdAt: string;
  requestId?: string;
  taskId?: string;
  runId?: string;
  chatKey: string;
  deliveryKind?: ChatDeliveryKind;
  coalesceWithWorkingMessage?: boolean;
  sessionId?: string;
  sessionFile?: string;
  sessionBinding?: "conversation";
  parts: ChatMessagePart[];
};

export type ChatOutboxPayloadInput =
  | ChatOutboxPayload
  | {
      createdAt?: string;
      chatKey: string;
      taskId?: string;
      runId?: string;
      requestId?: string;
      deliveryKind?: ChatDeliveryKind;
      coalesceWithWorkingMessage?: boolean;
      sessionId?: string;
      sessionFile?: string;
      sessionBinding?: "conversation";
      parts?: ChatMessagePart[];
    };

export type ChatOutboxDeliveryKind =
  | "final"
  | "interim"
  | "passive_notice"
  | "error"
  | "command_ack"
  | "generic";

export type ChatOutboxPostDelivery = {
  markProcessed?: {
    chatKey: string;
    messageId: string;
    sessionFile?: string;
    bindSession?: boolean;
  };
};

export type ChatOutboxItemStatus =
  | "queued"
  | "sending"
  | "delivered"
  | "failed";

export type ChatOutboxItem = {
  id: string;
  turnId?: string;
  idempotencyKey?: string;
  status: ChatOutboxItemStatus;
  createdAt: string;
  updatedAt: string;
  sequence: number;
  deliveryKind: ChatOutboxDeliveryKind;
  payload: ChatOutboxPayload;
  attempts: number;
  ownerEpoch?: string;
  leaseUntil?: string;
  lastError?: string;
  nextAttemptAt?: string;
  failedAt?: string;
  failureKind?:
    | "retryable"
    | "partial"
    | "permanent"
    | "attempts_exhausted"
    | "expired";
  deliveredAt?: string;
  deliveryResult?: string[];
  deliveryUnconfirmed?: boolean;
  postDelivery?: ChatOutboxPostDelivery;
  postDeliveryAppliedAt?: string;
  dispatchStartedAt?: string;
  claimedFromStatus?: "queued" | "sending";
};

export type ChatOutboxDelivery = {
  deliveryId: string;
  outboxId: string;
  destination: string;
  fragmentIndex: number;
  state: "queued" | "sending" | "delivered" | "failed" | "unconfirmed";
  providerMessageId?: string;
  attempt: number;
  ownerEpoch?: string;
};

export type EnqueueChatOutboxOptions = {
  id?: string;
  idempotencyKey?: string;
  deliveryKind?: ChatOutboxDeliveryKind;
  postDelivery?: ChatOutboxPostDelivery;
  turnFence?: ChatOutboxTurnFence;
  supersedeTurnFences?: ChatOutboxTurnFence[];
};

export type ChatOutboxTurnFence = {
  agentDir: string;
  turnId: string;
  chatKey: string;
  messageId: string;
  ownerEpoch: string;
  attempt: number;
};

const activeTurnFence = new AsyncLocalStorage<ChatOutboxTurnFence>();

export function getActiveChatOutboxTurnFence() {
  return activeTurnFence.getStore();
}

export function runWithChatOutboxTurnFence<T>(
  fence: ChatOutboxTurnFence,
  run: () => T,
): T {
  return activeTurnFence.run(fence, run);
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const CHAT_OUTBOX_DELIVERED_HISTORY_RETENTION_MS = 7 * DAY_MS;
export const CHAT_OUTBOX_FAILED_HISTORY_RETENTION_MS = 14 * DAY_MS;

let sequenceCounter = 0;

function nowIso() {
  return new Date().toISOString();
}

function sanitizeIdPart(value: unknown) {
  return safeString(value)
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

function createOutboxId() {
  const seq = (sequenceCounter = (sequenceCounter + 1) % 1_000_000);
  return `${Date.now()}-${process.pid}-${seq}-${Math.random().toString(36).slice(2)}`;
}

function stableOutboxIdForKey(key: string) {
  return `dedupe-${crypto.createHash("sha256").update(key).digest("hex")}`;
}

function normalizeDeliveryKind(value: unknown): ChatOutboxDeliveryKind {
  const text = safeString(value).trim();
  if (
    [
      "final",
      "interim",
      "passive_notice",
      "error",
      "command_ack",
      "generic",
    ].includes(text)
  ) {
    return text as ChatOutboxDeliveryKind;
  }
  return "generic";
}

export function withChatQuotePart(
  parts: ChatMessagePart[],
  replyToMessageId: unknown,
) {
  const nodes = Array.isArray(parts) ? parts.filter(Boolean) : [];
  const id = safeString(replyToMessageId).trim();
  if (!id || nodes.some((part) => part.type === "quote")) return nodes;
  return [{ type: "quote" as const, id }, ...nodes];
}

export function normalizeChatOutboxPayload(
  raw: unknown,
  options: { allowLegacyReplyMetadata?: boolean } = {},
): ChatOutboxPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const payload = raw as Record<string, unknown>;
  const chatKey = safeString(payload.chatKey).trim();
  if (!chatKey || "type" in payload) return null;
  if (
    "replyToMessageId" in payload &&
    options.allowLegacyReplyMetadata !== true
  ) {
    return null;
  }
  const legacyReplyToMessageId = payload.replyToMessageId;
  const { replyToMessageId: _legacyReplyToMessageId, ...rest } = payload;
  const parts = withChatQuotePart(
    Array.isArray(payload.parts)
      ? (payload.parts.filter(Boolean) as ChatMessagePart[])
      : [],
    legacyReplyToMessageId,
  );
  if (!parts.length) return null;
  return {
    ...rest,
    chatKey,
    parts,
    createdAt: safeString(payload.createdAt).trim() || nowIso(),
  } as ChatOutboxPayload;
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    const parsed = JSON.parse(safeString(value));
    return (parsed ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function rowToOutboxItem(row: any): ChatOutboxItem | null {
  if (!row) return null;
  const payload = normalizeChatOutboxPayload(
    parseJson<ChatOutboxPayload | null>(row.payload_json, null),
    { allowLegacyReplyMetadata: true },
  );
  if (!payload) return null;
  const postDelivery = parseJson<ChatOutboxPostDelivery | null>(
    row.post_delivery_json,
    null,
  );
  const deliveryResult = parseJson<string[]>(row.delivery_result_json, []);
  return {
    id: safeString(row.outbox_id),
    turnId: safeString(row.turn_id).trim() || undefined,
    idempotencyKey: safeString(row.idempotency_key).trim() || undefined,
    status: safeString(row.state) as ChatOutboxItemStatus,
    createdAt: safeString(row.created_at),
    updatedAt: safeString(row.updated_at),
    sequence: Number(row.sequence),
    deliveryKind: normalizeDeliveryKind(row.delivery_kind),
    payload,
    attempts: Math.max(0, Number(row.attempts || 0)),
    ownerEpoch: safeString(row.owner_epoch).trim() || undefined,
    leaseUntil: safeString(row.lease_until).trim() || undefined,
    lastError: safeString(row.last_error).trim() || undefined,
    nextAttemptAt: safeString(row.next_attempt_at).trim() || undefined,
    failedAt: safeString(row.failed_at).trim() || undefined,
    failureKind: safeString(
      row.failure_kind,
    ).trim() as ChatOutboxItem["failureKind"],
    deliveredAt: safeString(row.delivered_at).trim() || undefined,
    deliveryResult: deliveryResult.length ? deliveryResult : undefined,
    deliveryUnconfirmed: Number(row.delivery_unconfirmed) === 1 || undefined,
    postDelivery: postDelivery || undefined,
    postDeliveryAppliedAt:
      safeString(row.post_delivery_applied_at).trim() || undefined,
    dispatchStartedAt: safeString(row.dispatch_started_at).trim() || undefined,
  };
}

export function hasCommittedTerminalChatOutbox(
  agentDir: string,
  chatKey: string,
  messageId: string,
) {
  return Boolean(
    openChatDatabase(agentDir)
      .prepare(
        `SELECT 1
         FROM turns
         JOIN messages ON messages.id = turns.inbound_message_id
         JOIN outbox ON outbox.turn_id = turns.turn_id
         WHERE turns.chat_key = ? AND messages.message_id = ?
           AND turns.state = 'terminal'
         LIMIT 1`,
      )
      .get(safeString(chatKey).trim(), safeString(messageId).trim()),
  );
}

export function isCommittedTerminalChatOutboxItem(
  agentDir: string,
  outboxId: string,
) {
  return Boolean(
    openChatDatabase(agentDir)
      .prepare(
        `SELECT 1
         FROM outbox
         WHERE outbox.outbox_id = ?
           AND (outbox.delivery_kind IN ('final', 'error', 'command_ack')
                OR outbox.post_delivery_json IS NOT NULL)
         LIMIT 1`,
      )
      .get(safeString(outboxId).trim()),
  );
}

export function readChatOutboxItemById(agentDir: string, id: string) {
  const item = rowToOutboxItem(
    openChatDatabase(agentDir)
      .prepare(`SELECT * FROM outbox WHERE outbox_id = ?`)
      .get(safeString(id).trim()),
  );
  return item ? { item } : null;
}

export function listChatOutboxItems(agentDir: string) {
  return openChatDatabase(agentDir)
    .prepare(
      `SELECT * FROM outbox
       WHERE state IN ('queued', 'sending')
       ORDER BY sequence, outbox_id`,
    )
    .all()
    .map(rowToOutboxItem)
    .filter((item): item is ChatOutboxItem => Boolean(item))
    .map((item) => ({ item }));
}

export function listCommittedChatOutboxItems(agentDir: string) {
  return openChatDatabase(agentDir)
    .prepare(
      `SELECT * FROM outbox
       WHERE post_delivery_json IS NOT NULL
         AND post_delivery_applied_at IS NULL
         AND (state IN ('queued', 'sending', 'delivered')
              OR (state = 'failed' AND failure_kind = 'partial'))
       ORDER BY sequence, outbox_id`,
    )
    .all()
    .map(rowToOutboxItem)
    .filter((item): item is ChatOutboxItem => Boolean(item));
}

export function markChatOutboxPostDeliveryApplied(
  agentDir: string,
  id: string,
  appliedAt = nowIso(),
) {
  return (
    openChatDatabase(agentDir)
      .prepare(
        `UPDATE outbox SET post_delivery_applied_at = ?, updated_at = ?
         WHERE outbox_id = ? AND post_delivery_json IS NOT NULL
           AND post_delivery_applied_at IS NULL`,
      )
      .run(appliedAt, appliedAt, safeString(id).trim()).changes === 1
  );
}

export function listChatOutboxHistoryItems(
  agentDir: string,
  status: "delivered" | "failed",
) {
  return openChatDatabase(agentDir)
    .prepare(
      `SELECT * FROM outbox WHERE state = ? ORDER BY sequence, outbox_id`,
    )
    .all(status)
    .map(rowToOutboxItem)
    .filter((item): item is ChatOutboxItem => Boolean(item));
}

export function listChatOutboxDeliveries(agentDir: string, outboxId: string) {
  return openChatDatabase(agentDir)
    .prepare(
      `SELECT * FROM outbox_deliveries
       WHERE outbox_id = ?
       ORDER BY destination, fragment_index`,
    )
    .all(outboxId)
    .map(
      (row: any): ChatOutboxDelivery => ({
        deliveryId: safeString(row.delivery_id),
        outboxId: safeString(row.outbox_id),
        destination: safeString(row.destination),
        fragmentIndex: Number(row.fragment_index),
        state: safeString(row.state) as ChatOutboxDelivery["state"],
        providerMessageId:
          safeString(row.provider_message_id).trim() || undefined,
        attempt: Math.max(0, Number(row.attempt || 0)),
        ownerEpoch: safeString(row.owner_epoch).trim() || undefined,
      }),
    );
}

function validateChatOutboxTurnFence(
  db: ReturnType<typeof openChatDatabase>,
  agentDir: string,
  fence: ChatOutboxTurnFence,
  payloadChatKey?: string,
) {
  if (
    safeString(fence.agentDir).trim() !== safeString(agentDir).trim() ||
    (payloadChatKey &&
      safeString(fence.chatKey).trim() !== safeString(payloadChatKey).trim())
  ) {
    throw new Error("chat_turn_fence_lost");
  }
  const turn = db
    .prepare(
      `SELECT turns.turn_id, turns.inbound_message_id
       FROM turns
       JOIN messages ON messages.id = turns.inbound_message_id
       JOIN chat_state ON chat_state.chat_key = turns.chat_key
       WHERE turns.turn_id = ? AND turns.chat_key = ?
         AND messages.message_id = ?
         AND turns.state = 'running' AND turns.owner_epoch = ?
         AND turns.attempt = ?
         AND turns.generation = chat_state.current_generation`,
    )
    .get(
      safeString(fence.turnId).trim(),
      safeString(fence.chatKey).trim(),
      safeString(fence.messageId).trim(),
      safeString(fence.ownerEpoch).trim(),
      Math.max(1, Number(fence.attempt || 0)),
    ) as any;
  if (!turn) throw new Error("chat_turn_fence_lost");
  return turn;
}

function terminalTurnForPostDelivery(
  db: ReturnType<typeof openChatDatabase>,
  agentDir: string,
  deliveryKind: ChatOutboxDeliveryKind,
  postDelivery?: ChatOutboxPostDelivery,
  explicitFence?: ChatOutboxTurnFence,
) {
  const mark = postDelivery?.markProcessed;
  if (!["final", "error", "command_ack"].includes(deliveryKind) && !mark)
    return null;
  const fence = explicitFence || activeTurnFence.getStore();
  if (!fence) return null;
  if (
    mark &&
    (safeString(mark.chatKey).trim() !== safeString(fence.chatKey).trim() ||
      safeString(mark.messageId).trim() !== safeString(fence.messageId).trim())
  ) {
    throw new Error("chat_turn_fence_lost");
  }
  return validateChatOutboxTurnFence(
    db,
    agentDir,
    fence,
    safeString(mark?.chatKey).trim(),
  );
}

export function enqueueChatOutboxPayload(
  agentDir: string,
  payload: ChatOutboxPayloadInput,
  options: EnqueueChatOutboxOptions = {},
) {
  const createdAt = safeString(payload.createdAt).trim() || nowIso();
  const normalizedPayload = normalizeChatOutboxPayload({
    ...payload,
    createdAt,
  });
  if (!normalizedPayload) throw new Error("chat_outbox_invalid_payload");
  validateChatOutboxPayloadParts(normalizedPayload);
  const idempotencyKey = safeString(options.idempotencyKey).trim();
  const id =
    sanitizeIdPart(options.id) ||
    (idempotencyKey ? stableOutboxIdForKey(idempotencyKey) : createOutboxId());
  const deliveryKind = normalizeDeliveryKind(options.deliveryKind);
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const contextualFence = options.turnFence || activeTurnFence.getStore();
      const fencedTurn = contextualFence
        ? validateChatOutboxTurnFence(
            db,
            agentDir,
            contextualFence,
            normalizedPayload.chatKey,
          )
        : null;
      const turn = terminalTurnForPostDelivery(
        db,
        agentDir,
        deliveryKind,
        options.postDelivery,
        contextualFence,
      );
      const desiredTurnId = fencedTurn?.turn_id || turn?.turn_id || "";
      const supersedeCoalescedTurns = () => {
        const seen = new Set<string>();
        for (const fence of options.supersedeTurnFences || []) {
          const turnId = safeString(fence?.turnId).trim();
          if (!turnId || turnId === desiredTurnId || seen.has(turnId)) continue;
          seen.add(turnId);
          const owned = validateChatOutboxTurnFence(
            db,
            agentDir,
            fence,
            normalizedPayload.chatKey,
          );
          const timestamp = nowIso();
          const result = db
            .prepare(
              `UPDATE turns
               SET state = 'superseded', terminal_kind = 'coalesced_steer',
                   owner_epoch = NULL, lease_until = NULL, heartbeat_at = NULL,
                   next_attempt_at = NULL, last_error = NULL, updated_at = ?
               WHERE turn_id = ? AND state = 'running'`,
            )
            .run(timestamp, owned.turn_id);
          if (result.changes !== 1) throw new Error("chat_turn_fence_lost");
          db.prepare(
            `UPDATE messages
             SET disposition = 'superseded',
                 record_json = json_set(record_json, '$.disposition', 'superseded')
             WHERE id = ?`,
          ).run(owned.inbound_message_id);
        }
      };
      const adoptExisting = (row: any) => {
        if (safeString(row.chat_key).trim() !== normalizedPayload.chatKey) {
          throw new Error("chat_outbox_idempotency_collision");
        }
        const existingPayload: Partial<ChatOutboxPayload> =
          normalizeChatOutboxPayload(parseJson<any>(row.payload_json, {}), {
            allowLegacyReplyMetadata: true,
          }) || {};
        const existingPostDelivery = parseJson<any>(
          row.post_delivery_json,
          null,
        );
        const desiredPostDelivery = options.postDelivery || null;
        if (
          safeString(row.delivery_kind).trim() !== deliveryKind ||
          JSON.stringify(existingPayload?.parts || []) !==
            JSON.stringify(normalizedPayload.parts || []) ||
          (existingPostDelivery &&
            JSON.stringify(existingPostDelivery) !==
              JSON.stringify(desiredPostDelivery)) ||
          (desiredTurnId &&
            safeString(row.turn_id).trim() &&
            safeString(row.turn_id).trim() !== desiredTurnId)
        ) {
          throw new Error("chat_outbox_idempotency_collision");
        }
        if (desiredTurnId || idempotencyKey || desiredPostDelivery) {
          db.prepare(
            `UPDATE outbox
             SET turn_id = COALESCE(turn_id, ?),
                 idempotency_key = COALESCE(idempotency_key, ?),
                 post_delivery_json = COALESCE(post_delivery_json, ?),
                 state = CASE
                   WHEN ? = 1 AND state = 'failed'
                     AND COALESCE(failure_kind, '') <> 'permanent'
                   THEN 'queued' ELSE state END,
                 failed_at = CASE
                   WHEN ? = 1 AND state = 'failed'
                     AND COALESCE(failure_kind, '') <> 'permanent'
                   THEN NULL ELSE failed_at END,
                 failure_kind = CASE
                   WHEN ? = 1 AND state = 'failed'
                     AND COALESCE(failure_kind, '') <> 'permanent'
                   THEN NULL ELSE failure_kind END,
                 next_attempt_at = CASE
                   WHEN ? = 1 AND state = 'failed'
                     AND COALESCE(failure_kind, '') <> 'permanent'
                   THEN NULL ELSE next_attempt_at END,
                 updated_at = ?
             WHERE outbox_id = ?`,
          ).run(
            desiredTurnId || null,
            idempotencyKey || null,
            desiredPostDelivery ? JSON.stringify(desiredPostDelivery) : null,
            turn ? 1 : 0,
            turn ? 1 : 0,
            turn ? 1 : 0,
            turn ? 1 : 0,
            nowIso(),
            safeString(row.outbox_id),
          );
          if (turn) {
            db.prepare(
              `UPDATE outbox_deliveries
               SET state = 'queued', owner_epoch = NULL, lease_until = NULL,
                   next_attempt_at = NULL, last_error = NULL, failed_at = NULL,
                   updated_at = ?
               WHERE outbox_id = ? AND state = 'failed'
                 AND EXISTS (
                   SELECT 1 FROM outbox
                   WHERE outbox_id = ? AND state = 'queued'
                 )`,
            ).run(
              nowIso(),
              safeString(row.outbox_id),
              safeString(row.outbox_id),
            );
          }
        }
        if (turn) {
          const timestamp = nowIso();
          const terminalized = db
            .prepare(
              `UPDATE turns
               SET state = 'terminal', terminal_kind = ?, owner_epoch = NULL,
                   lease_until = NULL, heartbeat_at = NULL,
                   next_attempt_at = NULL, last_error = NULL, updated_at = ?
               WHERE turn_id = ? AND state = 'running'`,
            )
            .run(`outbox_${deliveryKind}`, timestamp, turn.turn_id);
          if (terminalized.changes !== 1) {
            throw new Error("chat_turn_fence_lost");
          }
          db.prepare(
            `UPDATE messages
             SET disposition = 'actionable',
                 record_json = json_set(record_json, '$.disposition', 'actionable')
             WHERE id = ?`,
          ).run(turn.inbound_message_id);
        }
        supersedeCoalescedTurns();
        return safeString(row.outbox_id);
      };
      const existing = db
        .prepare(`SELECT * FROM outbox WHERE outbox_id = ?`)
        .get(id) as any;
      if (existing) {
        if (
          idempotencyKey &&
          safeString(existing.idempotency_key) &&
          safeString(existing.idempotency_key) !== idempotencyKey
        ) {
          throw new Error("chat_outbox_idempotency_collision");
        }
        return adoptExisting(existing);
      }
      if (idempotencyKey) {
        const sameKey = db
          .prepare(`SELECT * FROM outbox WHERE idempotency_key = ?`)
          .get(idempotencyKey) as any;
        if (sameKey) return adoptExisting(sameKey);
      }
      const sequence = Number(
        (
          db
            .prepare(
              `SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM outbox`,
            )
            .get() as any
        )?.value || 1,
      );
      db.prepare(
        `INSERT INTO outbox (
        outbox_id, turn_id, idempotency_key, chat_key, delivery_kind, state,
        payload_json, post_delivery_json, post_delivery_applied_at,
        adapter_id, adapter_version, plan_state, sequence, attempts,
        owner_epoch, lease_until, next_attempt_at, last_error, failure_kind,
        delivery_unconfirmed, delivery_result_json, created_at, updated_at,
        delivered_at, failed_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, NULL, ?, '1', 'planned', ?, 0,
                NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, ?, NULL, NULL)`,
      ).run(
        id,
        fencedTurn?.turn_id || turn?.turn_id || null,
        idempotencyKey || null,
        normalizedPayload.chatKey,
        deliveryKind,
        JSON.stringify(normalizedPayload),
        options.postDelivery ? JSON.stringify(options.postDelivery) : null,
        normalizedPayload.chatKey.split("/", 1)[0] || "unknown",
        sequence,
        createdAt,
        createdAt,
      );
      db.prepare(
        `INSERT INTO outbox_deliveries (
        delivery_id, outbox_id, destination, fragment_index, state,
        payload_json, owner_epoch, attempt, lease_until, next_attempt_at,
        last_error, provider_message_id, created_at, updated_at,
        delivered_at, failed_at
      ) VALUES (?, ?, ?, 0, 'queued', ?, NULL, 0, NULL, NULL, NULL, NULL,
                ?, ?, NULL, NULL)`,
      ).run(
        `${id}:0`,
        id,
        normalizedPayload.chatKey,
        JSON.stringify(normalizedPayload),
        createdAt,
        createdAt,
      );
      if (turn) {
        const timestamp = nowIso();
        const terminalized = db
          .prepare(
            `UPDATE turns
             SET state = 'terminal', terminal_kind = ?, owner_epoch = NULL,
                 lease_until = NULL, heartbeat_at = NULL, next_attempt_at = NULL,
                 last_error = NULL, updated_at = ?
             WHERE turn_id = ? AND state = 'running'`,
          )
          .run(`outbox_${deliveryKind}`, timestamp, turn.turn_id);
        if (terminalized.changes !== 1) {
          throw new Error("chat_turn_fence_lost");
        }
        db.prepare(
          `UPDATE messages SET disposition = 'actionable' WHERE id = ?`,
        ).run(turn.inbound_message_id);
      }
      supersedeCoalescedTurns();
      return id;
    })
    .immediate();
}

export function claimChatOutboxItem(
  agentDir: string,
  id: string,
  options: { leaseUntil: string; nowMs?: number },
) {
  const db = openChatDatabase(agentDir);
  const ownerEpoch = crypto.randomUUID();
  const now = new Date(Number(options.nowMs ?? Date.now())).toISOString();
  return db
    .transaction(() => {
      const previous = db
        .prepare(`SELECT state FROM outbox WHERE outbox_id = ?`)
        .get(id) as any;
      const result = db
        .prepare(
          `UPDATE outbox
       SET state = 'sending', attempts = attempts + 1, owner_epoch = ?,
           lease_until = ?, next_attempt_at = ?,
           dispatch_started_at = CASE
             WHEN state = 'queued' THEN NULL ELSE dispatch_started_at END,
           updated_at = ?
       WHERE outbox_id = ?
         AND (
           (state = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
           OR (state = 'sending' AND (lease_until IS NULL OR lease_until <= ?))
         )`,
        )
        .run(
          ownerEpoch,
          options.leaseUntil,
          options.leaseUntil,
          now,
          id,
          now,
          now,
        );
      if (result.changes !== 1) return null;
      const row = db
        .prepare(`SELECT * FROM outbox WHERE outbox_id = ?`)
        .get(id) as any;
      const item = rowToOutboxItem(row);
      if (!item) throw new Error("chat_outbox_claim_read_failed");
      item.claimedFromStatus =
        previous?.state === "sending" ? "sending" : "queued";
      db.prepare(
        `UPDATE outbox_deliveries
       SET state = 'sending', owner_epoch = ?, attempt = ?, lease_until = ?,
           next_attempt_at = ?, updated_at = ?
       WHERE outbox_id = ? AND state IN ('queued', 'sending')`,
      ).run(
        ownerEpoch,
        item.attempts,
        options.leaseUntil,
        options.leaseUntil,
        now,
        id,
      );
      return item;
    })
    .immediate();
}

export function markChatOutboxDispatchStarted(
  agentDir: string,
  item: Pick<ChatOutboxItem, "id" | "ownerEpoch" | "attempts">,
) {
  const timestamp = nowIso();
  const result = openChatDatabase(agentDir)
    .prepare(
      `UPDATE outbox
       SET dispatch_started_at = ?, updated_at = ?
       WHERE outbox_id = ? AND state = 'sending'
         AND owner_epoch = ? AND attempts = ?`,
    )
    .run(
      timestamp,
      timestamp,
      safeString(item.id).trim(),
      safeString(item.ownerEpoch).trim(),
      Math.max(0, Number(item.attempts || 0)),
    );
  return result.changes === 1 ? timestamp : "";
}

function syncDeliveriesForItem(
  db: ReturnType<typeof openChatDatabase>,
  item: ChatOutboxItem,
) {
  const payloadJson = JSON.stringify(item.payload);
  const timestamp = item.updatedAt || nowIso();
  if (item.status === "delivered" || item.status === "failed") {
    db.prepare(`DELETE FROM outbox_deliveries WHERE outbox_id = ?`).run(
      item.id,
    );
    const delivered = Array.isArray(item.deliveryResult)
      ? item.deliveryResult
      : [];
    delivered.forEach((providerMessageId, index) => {
      db.prepare(
        `INSERT INTO outbox_deliveries (
          delivery_id, outbox_id, destination, fragment_index, state,
          payload_json, owner_epoch, attempt, lease_until, next_attempt_at,
          last_error, provider_message_id, created_at, updated_at,
          delivered_at, failed_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        `${item.id}:${index}`,
        item.id,
        item.payload.chatKey,
        index,
        "delivered",
        payloadJson,
        item.attempts,
        item.lastError || null,
        providerMessageId,
        item.createdAt,
        timestamp,
        item.deliveredAt || timestamp,
      );
    });
    if (
      item.status === "failed" ||
      !delivered.length ||
      item.deliveryUnconfirmed
    ) {
      const index = delivered.length;
      db.prepare(
        `INSERT INTO outbox_deliveries (
          delivery_id, outbox_id, destination, fragment_index, state,
          payload_json, owner_epoch, attempt, lease_until, next_attempt_at,
          last_error, provider_message_id, created_at, updated_at,
          delivered_at, failed_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, ?, ?, NULL, ?)`,
      ).run(
        `${item.id}:${index}`,
        item.id,
        item.payload.chatKey,
        index,
        item.status === "failed"
          ? "failed"
          : item.deliveryUnconfirmed
            ? "unconfirmed"
            : "delivered",
        payloadJson,
        item.attempts,
        item.lastError || null,
        item.createdAt,
        timestamp,
        item.status === "failed" ? item.failedAt || timestamp : null,
      );
    }
    return;
  }
  db.prepare(
    `UPDATE outbox_deliveries
     SET state = ?, owner_epoch = ?, attempt = ?, lease_until = ?,
         next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE outbox_id = ? AND state IN ('queued', 'sending')`,
  ).run(
    item.status,
    item.ownerEpoch || null,
    item.attempts,
    item.leaseUntil || null,
    item.nextAttemptAt || null,
    item.lastError || null,
    timestamp,
    item.id,
  );
}

export function writeChatOutboxItem(agentDir: string, item: ChatOutboxItem) {
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const ownerEpoch = safeString(item.ownerEpoch).trim();
      const terminal = item.status === "delivered" || item.status === "failed";
      const sql = ownerEpoch
        ? `UPDATE outbox SET
           state = @state, owner_epoch = @next_owner_epoch,
           lease_until = @lease_until, next_attempt_at = @next_attempt_at,
           last_error = @last_error, failure_kind = @failure_kind,
           delivery_unconfirmed = @delivery_unconfirmed,
           delivery_result_json = @delivery_result_json,
           dispatch_started_at = @dispatch_started_at,
           updated_at = @updated_at, delivered_at = @delivered_at,
           failed_at = @failed_at
         WHERE outbox_id = @id AND state = 'sending'
           AND owner_epoch = @owner_epoch AND attempts = @attempts`
        : `UPDATE outbox SET
           state = @state, owner_epoch = @next_owner_epoch,
           lease_until = @lease_until, next_attempt_at = @next_attempt_at,
           last_error = @last_error, failure_kind = @failure_kind,
           delivery_unconfirmed = @delivery_unconfirmed,
           delivery_result_json = @delivery_result_json,
           dispatch_started_at = @dispatch_started_at,
           updated_at = @updated_at, delivered_at = @delivered_at,
           failed_at = @failed_at, attempts = @attempts
         WHERE outbox_id = @id AND state = 'queued'`;
      const result = db.prepare(sql).run({
        id: item.id,
        state: item.status,
        owner_epoch: ownerEpoch,
        next_owner_epoch:
          terminal || item.status === "queued" ? null : ownerEpoch || null,
        lease_until:
          terminal || item.status === "queued"
            ? null
            : item.leaseUntil || item.nextAttemptAt || null,
        next_attempt_at: terminal ? null : item.nextAttemptAt || null,
        last_error: item.lastError || null,
        failure_kind: item.failureKind || null,
        delivery_unconfirmed: item.deliveryUnconfirmed ? 1 : 0,
        delivery_result_json: item.deliveryResult?.length
          ? JSON.stringify(item.deliveryResult)
          : null,
        dispatch_started_at:
          item.status === "queued" ? null : item.dispatchStartedAt || null,
        updated_at: item.updatedAt || nowIso(),
        delivered_at: item.deliveredAt || null,
        failed_at: item.failedAt || null,
        attempts: item.attempts,
      });
      if (result.changes !== 1) return false;
      syncDeliveriesForItem(db, {
        ...item,
        ownerEpoch:
          terminal || item.status === "queued" ? undefined : item.ownerEpoch,
        leaseUntil:
          terminal || item.status === "queued" ? undefined : item.leaseUntil,
      });
      return true;
    })
    .immediate();
}

export function cleanupChatOutboxHistory(
  agentDir: string,
  options: {
    nowMs?: number;
    deliveredRetentionMs?: number;
    failedRetentionMs?: number;
  } = {},
) {
  const nowMs = Number(options.nowMs || Date.now());
  const deliveredCutoff = new Date(
    nowMs -
      Math.max(
        0,
        Number(
          options.deliveredRetentionMs ??
            CHAT_OUTBOX_DELIVERED_HISTORY_RETENTION_MS,
        ),
      ),
  ).toISOString();
  const failedCutoff = new Date(
    nowMs -
      Math.max(
        0,
        Number(
          options.failedRetentionMs ?? CHAT_OUTBOX_FAILED_HISTORY_RETENTION_MS,
        ),
      ),
  ).toISOString();
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const delivered = db
        .prepare(
          `DELETE FROM outbox INDEXED BY outbox_delivered_cleanup_idx
           WHERE state = 'delivered' AND delivered_at <= ?`,
        )
        .run(deliveredCutoff).changes;
      const failed = db
        .prepare(
          `DELETE FROM outbox INDEXED BY outbox_failed_cleanup_idx
           WHERE state = 'failed' AND failed_at <= ?`,
        )
        .run(failedCutoff).changes;
      return { delivered, failed };
    })
    .immediate();
}
