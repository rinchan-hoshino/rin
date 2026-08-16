import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

import { CHAT_TERMINAL_OUTBOX_ID_GLOB, openChatDatabase } from "./database.js";
import { validateChatOutboxPayloadParts } from "./outbox-payload-validation.js";
import { withChatQuotePart } from "./delivery-presentation.js";
import { safeString } from "../text-utils.js";

import type {
  ChatMessagePart,
  ChatOutboxDelivery,
  ChatOutboxDeliveryKind,
  ChatOutboxItem,
  ChatOutboxItemStatus,
  ChatOutboxPayload,
  ChatOutboxPayloadInput,
  ChatOutboxPostDelivery,
  ChatOutboxTurnFence,
  ChatTerminalTurn,
  EnqueueChatOutboxOptions,
} from "../rin-lib/chat-outbox-contract.js";

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
         FROM inbox_jobs
         JOIN messages ON messages.id = inbox_jobs.inbound_message_id
         JOIN outbox ON outbox.turn_id = inbox_jobs.turn_id
         WHERE inbox_jobs.chat_key = ? AND messages.message_id = ?
           AND inbox_jobs.state = 'terminal'
           AND (outbox.outbox_id GLOB ?
                OR outbox.post_delivery_json IS NOT NULL)
         LIMIT 1`,
      )
      .get(
        safeString(chatKey).trim(),
        safeString(messageId).trim(),
        CHAT_TERMINAL_OUTBOX_ID_GLOB,
      ),
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
           AND (outbox.outbox_id GLOB ?
                OR outbox.post_delivery_json IS NOT NULL)
         LIMIT 1`,
      )
      .get(safeString(outboxId).trim(), CHAT_TERMINAL_OUTBOX_ID_GLOB),
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
      `SELECT inbox_jobs.turn_id, inbox_jobs.inbound_message_id,
              inbox_jobs.owner_epoch, inbox_jobs.attempt
       FROM inbox_jobs
       JOIN messages ON messages.id = inbox_jobs.inbound_message_id
       JOIN chat_state ON chat_state.chat_key = inbox_jobs.chat_key
       WHERE inbox_jobs.turn_id = ? AND inbox_jobs.chat_key = ?
         AND messages.message_id = ?
         AND inbox_jobs.state = 'running' AND inbox_jobs.owner_epoch = ?
         AND inbox_jobs.attempt = ?
         AND inbox_jobs.generation = chat_state.current_generation`,
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

export function isChatOutboxTurnFenceActive(
  agentDir: string,
  fence: ChatOutboxTurnFence,
  payloadChatKey = fence.chatKey,
) {
  try {
    validateChatOutboxTurnFence(
      openChatDatabase(agentDir),
      agentDir,
      fence,
      payloadChatKey,
    );
    return true;
  } catch {
    return false;
  }
}

function validateAuthoritativeTerminalTurn(
  db: ReturnType<typeof openChatDatabase>,
  terminalTurn: ChatTerminalTurn,
  payloadChatKey: string,
) {
  if (
    safeString(terminalTurn.chatKey).trim() !==
    safeString(payloadChatKey).trim()
  ) {
    throw new Error("chat_terminal_turn_mismatch");
  }
  const turn = db
    .prepare(
      `SELECT inbox_jobs.turn_id, inbox_jobs.inbound_message_id,
              inbox_jobs.owner_epoch, inbox_jobs.attempt, inbox_jobs.state,
              inbox_jobs.terminal_kind
       FROM inbox_jobs
       JOIN messages ON messages.id = inbox_jobs.inbound_message_id
       WHERE inbox_jobs.turn_id = ? AND inbox_jobs.chat_key = ?
         AND messages.message_id = ?
         AND (
           inbox_jobs.state IN ('running', 'terminal')
           OR (inbox_jobs.state = 'failed'
               AND inbox_jobs.terminal_kind = 'interrupted')
         )`,
    )
    .get(
      safeString(terminalTurn.turnId).trim(),
      safeString(terminalTurn.chatKey).trim(),
      safeString(terminalTurn.messageId).trim(),
    ) as any;
  if (!turn) throw new Error("chat_terminal_turn_mismatch");
  return turn;
}

function settlingTurnForPostDelivery(
  db: ReturnType<typeof openChatDatabase>,
  agentDir: string,
  postDelivery?: ChatOutboxPostDelivery,
  explicitFence?: ChatOutboxTurnFence,
) {
  if (!postDelivery) return null;
  const mark = postDelivery.markProcessed;
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
  let normalizedPayload = normalizeChatOutboxPayload({
    ...payload,
    createdAt,
  });
  if (!normalizedPayload) throw new Error("chat_outbox_invalid_payload");
  const deliveryKind =
    normalizeDeliveryKind(options.deliveryKind) === "error" ||
    normalizeDeliveryKind(normalizedPayload.deliveryKind) === "error"
      ? "error"
      : normalizeDeliveryKind(
          options.deliveryKind || normalizedPayload.deliveryKind,
        );
  normalizedPayload = {
    ...normalizedPayload,
    ...(deliveryKind === "command_ack" || deliveryKind === "generic"
      ? {}
      : { deliveryKind }),
  };
  validateChatOutboxPayloadParts(normalizedPayload);
  const executionSessionFile =
    safeString(normalizedPayload.sessionFile).trim() || null;
  const turnTerminalKind = `outbox_${deliveryKind}`;
  const idempotencyKey = safeString(options.idempotencyKey).trim();
  const id =
    sanitizeIdPart(options.id) ||
    (idempotencyKey ? stableOutboxIdForKey(idempotencyKey) : createOutboxId());
  const terminalRecordId = safeString(options.terminalRecordId).trim();
  const terminalOutboxId = terminalRecordId ? `chat-${terminalRecordId}` : "";
  const usesCanonicalTerminalNamespace =
    id.startsWith("chat-terminal-") && id.length > "chat-terminal-".length;
  if (
    options.terminalTurn
      ? !terminalRecordId.startsWith("terminal-") ||
        terminalRecordId.length <= "terminal-".length ||
        id !== terminalOutboxId ||
        idempotencyKey !== id
      : usesCanonicalTerminalNamespace
  ) {
    throw new Error("chat_terminal_record_missing");
  }
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const contextualFence = options.terminalTurn
        ? undefined
        : options.turnFence || activeTurnFence.getStore();
      const fencedTurn = contextualFence
        ? validateChatOutboxTurnFence(
            db,
            agentDir,
            contextualFence,
            normalizedPayload.chatKey,
          )
        : null;
      const turn = options.terminalTurn
        ? validateAuthoritativeTerminalTurn(
            db,
            options.terminalTurn,
            normalizedPayload.chatKey,
          )
        : settlingTurnForPostDelivery(
            db,
            agentDir,
            options.postDelivery,
            contextualFence,
          );
      const desiredTurnId = fencedTurn?.turn_id || turn?.turn_id || "";
      // `completed` settles Chat admission transport, not backend lifecycle truth.
      const projectsAuthoritativeTerminalOverCompletedTransport = Boolean(
        options.terminalTurn &&
        terminalRecordId &&
        turn?.state === "terminal" &&
        safeString(turn.terminal_kind) === "completed",
      );
      const existingAuthoritativeTerminal = desiredTurnId
        ? (db
            .prepare(
              `SELECT outbox_id FROM outbox
               WHERE turn_id = ? AND outbox_id GLOB ?
               LIMIT 1`,
            )
            .get(desiredTurnId, CHAT_TERMINAL_OUTBOX_ID_GLOB) as
            | { outbox_id?: string }
            | undefined)
        : undefined;
      if (
        safeString(existingAuthoritativeTerminal?.outbox_id) &&
        safeString(existingAuthoritativeTerminal?.outbox_id) !== id
      ) {
        throw new Error("chat_terminal_turn_mismatch");
      }
      const adoptExisting = (
        row: any,
        adoptOptions: { acceptLegacyTerminalPayload?: boolean } = {},
      ) => {
        if (turn?.state === "terminal") {
          if (
            safeString(row.turn_id) !== safeString(turn.turn_id) ||
            safeString(row.delivery_kind) !== safeString(deliveryKind) ||
            safeString(turn.terminal_kind) !== safeString(turnTerminalKind)
          ) {
            throw new Error("chat_terminal_turn_mismatch");
          }
          return safeString(row.outbox_id);
        }
        if (safeString(row.chat_key).trim() !== normalizedPayload.chatKey) {
          throw new Error("chat_outbox_idempotency_collision");
        }
        const existingPayload: Partial<ChatOutboxPayload> =
          normalizeChatOutboxPayload(parseJson<any>(row.payload_json, {}), {
            allowLegacyReplyMetadata: true,
          }) || {};
        const existingParts = existingPayload.parts || [];
        const comparableExistingParts =
          normalizeDeliveryKind(row.delivery_kind) === "error" &&
          typeof options.normalizeExistingErrorParts === "function"
            ? options.normalizeExistingErrorParts(existingParts)
            : existingParts;
        const existingPostDelivery = parseJson<any>(
          row.post_delivery_json,
          null,
        );
        const desiredPostDelivery = options.postDelivery || null;
        if (
          safeString(row.delivery_kind).trim() !== deliveryKind ||
          (!adoptOptions.acceptLegacyTerminalPayload &&
            JSON.stringify(comparableExistingParts) !==
              JSON.stringify(normalizedPayload.parts || [])) ||
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
              `UPDATE inbox_jobs
               SET state = 'terminal', terminal_kind = ?, owner_epoch = NULL,
                   lease_until = NULL, heartbeat_at = NULL,
                   next_attempt_at = NULL, last_error = NULL,
                   execution_session_file = COALESCE(execution_session_file, ?),
                   updated_at = ?
               WHERE turn_id = ?
                 AND (
                   (state = 'running' AND owner_epoch = ? AND attempt = ?
                    AND (? IS NULL OR execution_session_file IS NULL
                         OR execution_session_file = ?))
                   OR
                   (state = 'failed' AND terminal_kind = 'interrupted')
                   OR
                   (state = 'terminal' AND terminal_kind = 'completed' AND ? = 1)
                 )`,
            )
            .run(
              turnTerminalKind,
              executionSessionFile,
              timestamp,
              turn.turn_id,
              safeString(turn.owner_epoch),
              Number(turn.attempt),
              executionSessionFile,
              executionSessionFile,
              projectsAuthoritativeTerminalOverCompletedTransport ? 1 : 0,
            );
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
      if (
        !options.terminalTurn &&
        turn &&
        desiredTurnId &&
        deliveryKind !== "interim"
      ) {
        const legacyTerminal = db
          .prepare(
            `SELECT * FROM outbox
             WHERE turn_id = ? AND delivery_kind = ?
               AND post_delivery_json IS NULL
             ORDER BY sequence ASC
             LIMIT 1`,
          )
          .get(desiredTurnId, deliveryKind) as any;
        if (legacyTerminal) {
          return adoptExisting(legacyTerminal, {
            acceptLegacyTerminalPayload: true,
          });
        }
      }
      if (
        turn?.state === "terminal" &&
        !projectsAuthoritativeTerminalOverCompletedTransport
      ) {
        throw new Error("chat_terminal_turn_mismatch");
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
            `UPDATE inbox_jobs
             SET state = 'terminal', terminal_kind = ?, owner_epoch = NULL,
                 lease_until = NULL, heartbeat_at = NULL, next_attempt_at = NULL,
                 last_error = NULL,
                 execution_session_file = COALESCE(execution_session_file, ?),
                 updated_at = ?
             WHERE turn_id = ?
               AND (
                 (state = 'running' AND owner_epoch = ? AND attempt = ?
                  AND (? IS NULL OR execution_session_file IS NULL
                       OR execution_session_file = ?))
                 OR
                 (state = 'failed' AND terminal_kind = 'interrupted')
                 OR
                 (state = 'terminal' AND terminal_kind = 'completed' AND ? = 1)
               )`,
          )
          .run(
            turnTerminalKind,
            executionSessionFile,
            timestamp,
            turn.turn_id,
            safeString(turn.owner_epoch),
            Number(turn.attempt),
            executionSessionFile,
            executionSessionFile,
            projectsAuthoritativeTerminalOverCompletedTransport ? 1 : 0,
          );
        if (terminalized.changes !== 1) {
          throw new Error("chat_turn_fence_lost");
        }
        db.prepare(
          `UPDATE messages SET disposition = 'actionable' WHERE id = ?`,
        ).run(turn.inbound_message_id);
      }
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
