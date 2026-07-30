import crypto, { createHash } from "node:crypto";

import {
  asArray,
  cloneJson,
  cloneJsonIfObject,
  isJsonRecord,
} from "../json-utils.js";
import { nowIso } from "../time-utils.js";
import { safeString } from "../text-utils.js";
import {
  buildChatInboxRouting,
  buildInboundStoredChatMessageInput,
  migrateLegacyQuoteToElements,
  serializeChatInboxSession,
} from "./inbound-normalization.js";
import { openChatDatabase } from "./database.js";
import { saveInboundChatMessageInDatabase } from "./message-store.js";
import { parseChatKey } from "./support.js";
import {
  durableAdmissionMatchesTurn,
  type ChatInboxAdmission,
  type ChatInboxAdmissionState,
  type DurableChatAdmissionCommit,
  type DurableChatAdmissionDecision,
  type FrozenChatTurnSubmission,
} from "./durable-admission.js";

export type {
  ChatInboxAdmission,
  ChatInboxAdmissionState,
} from "./durable-admission.js";

function hashKey(value: string) {
  return createHash("sha1").update(value).digest("hex");
}

export type ChatInboxItemRouting = {
  chatType: "private" | "group";
  isDirect: boolean;
  mentionLike: boolean;
  text?: string;
  userId?: string;
  nickname?: string;
  chatName?: string;
  messageThreadId?: string;
  replyToMessageId?: string;
};

export type ChatInboxItemState = "pending" | "running" | "terminal" | "failed";

export type ChatInboxItem = {
  version: 1;
  itemId: string;
  chatKey: string;
  messageId: string;
  createdAt: string;
  updatedAt: string;
  lastReceivedAt?: string;
  duplicateCount?: number;
  attemptCount: number;
  nextAttemptAt?: string;
  lastError?: string;
  routing: ChatInboxItemRouting;
  session: Record<string, unknown>;
  elements: any[];
  admission: ChatInboxAdmission;
  state?: ChatInboxItemState;
  ownerEpoch?: string;
  leaseUntil?: string;
};

export type ClaimedChatInboxItem = ChatInboxItem & {
  state: "running";
  ownerEpoch: string;
};

export type RestoredChatInboxProcessingItem = {
  itemId: string;
  chatKey: string;
  messageId: string;
};

const DEFAULT_CHAT_INBOX_LEASE_MS = 5 * 60 * 1000;

export function buildChatInboxItem(input: {
  chatKey: string;
  messageId: string;
  session: any;
  elements: any[];
}) {
  const chatKey = safeString(input.chatKey).trim();
  const messageId = safeString(input.messageId).trim();
  if (!chatKey) throw new Error("chat_inbox_chatKey_required");
  if (!parseChatKey(chatKey)) throw new Error(`invalid_chatKey:${chatKey}`);
  if (!messageId) throw new Error("chat_inbox_messageId_required");
  const now = nowIso();
  const elements = Array.isArray(input.elements)
    ? input.elements.filter(Boolean)
    : [];
  return {
    version: 1 as const,
    itemId: hashKey(`${chatKey}\n${messageId}`),
    chatKey,
    messageId,
    createdAt: now,
    updatedAt: now,
    attemptCount: 0,
    routing: buildChatInboxRouting(input.session, elements),
    session: serializeChatInboxSession(input.session),
    elements: cloneJson(elements),
    admission: { state: "unclassified" as const },
    state: "pending" as const,
  } satisfies ChatInboxItem;
}

function parseJsonObject(value: unknown) {
  try {
    const parsed = JSON.parse(safeString(value));
    return isJsonRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: unknown) {
  try {
    const parsed = JSON.parse(safeString(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseOptionalJsonObject(value: unknown) {
  const text = safeString(value).trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text);
    return isJsonRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function hashDurableJson(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function admissionFromRow(row: any): ChatInboxAdmission {
  const state = safeString(row?.admission_state) as ChatInboxAdmissionState;
  const stateIntegrity = ["unclassified", "actionable", "record_only"].includes(
    state,
  )
    ? "valid"
    : "invalid";
  const admissionState = ["actionable", "record_only"].includes(state)
    ? state
    : "unclassified";
  const decisionText = safeString(row?.admission_json);
  const admissionHash = safeString(row?.admission_hash);
  const decision = parseOptionalJsonObject(decisionText) as
    | DurableChatAdmissionDecision
    | undefined;
  const decisionIntegrity =
    !decisionText && !admissionHash
      ? "none"
      : decisionText &&
          admissionHash &&
          decision &&
          hashDurableJson(decisionText) === admissionHash
        ? "valid"
        : "invalid";
  const submissionText = safeString(row?.submission_json);
  const submissionHash = safeString(row?.submission_hash);
  const submission = parseOptionalJsonObject(submissionText) as
    | FrozenChatTurnSubmission
    | undefined;
  const submissionIntegrity =
    !submissionText && !submissionHash
      ? "none"
      : submissionText &&
          submissionHash &&
          submission &&
          hashDurableJson(submissionText) === submissionHash
        ? "valid"
        : "invalid";
  return {
    state: admissionState,
    stateIntegrity,
    decision,
    admissionHash: admissionHash || undefined,
    decisionIntegrity,
    submission,
    submissionHash: submissionHash || undefined,
    submissionIntegrity,
    executionSessionFile:
      safeString(row?.execution_session_file).trim() || undefined,
  };
}

function rowToChatInboxItem(row: any): ChatInboxItem | null {
  if (!row) return null;
  const chatKey = safeString(row.chat_key).trim();
  const messageId = safeString(row.message_id).trim();
  if (!chatKey || !messageId) return null;
  const state = safeString(row.state) as ChatInboxItemState;
  return {
    version: 1,
    itemId: safeString(row.turn_id),
    chatKey,
    messageId,
    createdAt: safeString(row.created_at),
    updatedAt: safeString(row.updated_at),
    attemptCount: Math.max(0, Number(row.attempt || 0)),
    nextAttemptAt: safeString(row.next_attempt_at).trim() || undefined,
    lastError: safeString(row.last_error).trim() || undefined,
    routing: parseJsonObject(row.routing_json) as ChatInboxItemRouting,
    session: parseJsonObject(row.session_json),
    elements: parseJsonArray(row.elements_json),
    admission: admissionFromRow(row),
    state,
    ownerEpoch: safeString(row.owner_epoch).trim() || undefined,
    leaseUntil: safeString(row.lease_until).trim() || undefined,
  };
}

const INBOX_SELECT = `
  SELECT inbox_jobs.*, messages.message_id
  FROM inbox_jobs
  JOIN messages ON messages.id = inbox_jobs.inbound_message_id
`;

function getTurnRow(db: ReturnType<typeof openChatDatabase>, itemId: string) {
  return db
    .prepare(`${INBOX_SELECT} WHERE inbox_jobs.turn_id = ?`)
    .get(safeString(itemId).trim()) as any;
}

export function isChatInboxItemAccepted(agentDir: string, itemId: string) {
  return Boolean(
    openChatDatabase(agentDir)
      .prepare(
        `SELECT 1
         FROM inbox_jobs
         JOIN messages ON messages.id = inbox_jobs.inbound_message_id
         WHERE inbox_jobs.turn_id = ? AND messages.accepted_at IS NOT NULL
         LIMIT 1`,
      )
      .get(safeString(itemId).trim()),
  );
}

export function isChatInboxItemDurablyActionable(
  agentDir: string,
  itemId: string,
) {
  return Boolean(
    openChatDatabase(agentDir)
      .prepare(
        `SELECT 1 FROM inbox_jobs
         WHERE turn_id = ? AND admission_state = 'actionable'
         LIMIT 1`,
      )
      .get(safeString(itemId).trim()),
  );
}

export function getChatInboxItem(agentDir: string, itemId: string) {
  return rowToChatInboxItem(getTurnRow(openChatDatabase(agentDir), itemId));
}

export function listChatInboxItems(
  agentDir: string,
  states: ChatInboxItemState[] = ["pending"],
) {
  const normalized = states.filter((state) =>
    ["pending", "running", "terminal", "failed"].includes(state),
  );
  if (!normalized.length) return [];
  const placeholders = normalized.map(() => "?").join(", ");
  return openChatDatabase(agentDir)
    .prepare(
      `${INBOX_SELECT}
       WHERE inbox_jobs.state IN (${placeholders})
       ORDER BY inbox_jobs.chat_key, inbox_jobs.sequence, inbox_jobs.turn_id`,
    )
    .all(...normalized)
    .map(rowToChatInboxItem)
    .filter((item): item is ChatInboxItem => Boolean(item));
}

export function listPendingChatInboxItems(agentDir: string) {
  return listChatInboxItems(agentDir, ["pending"]);
}

export function listRunningChatInboxItems(agentDir: string) {
  return listChatInboxItems(agentDir, ["running"]);
}

export function enqueueChatInboxItem(
  agentDir: string,
  input: { chatKey: string; messageId: string; session: any; elements: any[] },
) {
  const item = buildChatInboxItem(input);
  const messageInput = buildInboundStoredChatMessageInput(
    input.session,
    item.elements,
    { chatKey: item.chatKey, receivedAt: item.createdAt },
  );
  if (!messageInput) throw new Error("chat_inbox_message_identity_required");
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const record = saveInboundChatMessageInDatabase(
        db,
        agentDir,
        messageInput,
      );
      const messageRow = db
        .prepare(
          `SELECT id, sequence, generation FROM messages WHERE chat_key = ? AND message_id = ?`,
        )
        .get(item.chatKey, item.messageId) as any;
      if (!messageRow) throw new Error("chat_inbox_message_commit_failed");
      const existing = getTurnRow(db, item.itemId);
      if (!existing) {
        db.prepare(
          `INSERT INTO inbox_jobs (
            turn_id, inbound_message_id, chat_key, generation, sequence, state,
            terminal_kind, owner_epoch, attempt, lease_until, heartbeat_at,
            next_attempt_at, last_error, routing_json, session_json,
            elements_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, 0, NULL, NULL,
                    NULL, NULL, ?, ?, ?, ?, ?)`,
        ).run(
          item.itemId,
          messageRow.id,
          item.chatKey,
          Number(messageRow.generation),
          Number(messageRow.sequence),
          JSON.stringify(item.routing),
          JSON.stringify(item.session),
          JSON.stringify(item.elements),
          item.createdAt,
          item.updatedAt,
        );
      } else if (existing.state === "pending") {
        db.prepare(
          `UPDATE inbox_jobs
           SET routing_json = ?, session_json = ?, elements_json = ?, updated_at = ?
           WHERE turn_id = ? AND state = 'pending'
             AND admission_state = 'unclassified'`,
        ).run(
          JSON.stringify(item.routing),
          JSON.stringify(item.session),
          JSON.stringify(item.elements),
          nowIso(),
          item.itemId,
        );
      }
      const next = rowToChatInboxItem(getTurnRow(db, item.itemId));
      if (!next) throw new Error("chat_inbox_turn_commit_failed");
      const duplicateCount = Math.max(0, Number(record.duplicateCount || 0));
      return {
        item: {
          ...next,
          duplicateCount: duplicateCount || undefined,
          lastReceivedAt: record.lastReceivedAt,
        },
      };
    })
    .immediate();
}

export function claimChatInboxItem(
  agentDir: string,
  itemId: string,
  options: { leaseMs?: number; nowMs?: number } = {},
): ClaimedChatInboxItem | null {
  const db = openChatDatabase(agentDir);
  const ownerEpoch = crypto.randomUUID();
  const nowMs = Number(options.nowMs ?? Date.now());
  const timestamp = new Date(nowMs).toISOString();
  const leaseUntil = new Date(
    nowMs + Math.max(1, Number(options.leaseMs || DEFAULT_CHAT_INBOX_LEASE_MS)),
  ).toISOString();
  return db
    .transaction(() => {
      const result = db
        .prepare(
          `UPDATE inbox_jobs
         SET state = 'running', owner_epoch = ?, attempt = attempt + 1,
             lease_until = ?, heartbeat_at = ?, updated_at = ?
         WHERE turn_id = ? AND state = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
        )
        .run(ownerEpoch, leaseUntil, timestamp, timestamp, itemId, timestamp);
      if (result.changes !== 1) return null;
      return rowToChatInboxItem(getTurnRow(db, itemId)) as ClaimedChatInboxItem;
    })
    .immediate();
}

function requireClaim(item: ChatInboxItem) {
  const itemId = safeString(item?.itemId).trim();
  const ownerEpoch = safeString(item?.ownerEpoch).trim();
  const attempt = Math.max(0, Number(item?.attemptCount || 0));
  if (!itemId || !ownerEpoch || attempt < 1) {
    throw new Error("chat_inbox_claim_required");
  }
  return { itemId, ownerEpoch, attempt };
}

export function commitClaimedChatInboxAdmission(
  agentDir: string,
  item: ClaimedChatInboxItem,
  input: DurableChatAdmissionCommit,
): ChatInboxAdmission | null {
  const claim = requireClaim(item);
  if (
    !durableAdmissionMatchesTurn(input, {
      chatKey: item.chatKey,
      messageId: item.messageId,
    })
  ) {
    throw new Error("chat_inbox_admission_identity_mismatch");
  }
  const decisionJson = JSON.stringify(cloneJson(input.decision));
  const submissionJson = input.submission
    ? JSON.stringify(cloneJson(input.submission))
    : null;
  const admissionHash = hashDurableJson(decisionJson);
  const submissionHash = submissionJson
    ? hashDurableJson(submissionJson)
    : null;
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const owned = getTurnRow(db, claim.itemId);
      if (
        owned?.state !== "running" ||
        safeString(owned.owner_epoch) !== claim.ownerEpoch ||
        Number(owned.attempt) !== claim.attempt
      ) {
        return null;
      }
      if (safeString(owned.admission_state) === "unclassified") {
        const committed = db
          .prepare(
            `UPDATE inbox_jobs
             SET admission_state = ?, admission_json = ?, admission_hash = ?,
                 submission_json = ?, submission_hash = ?, updated_at = ?
             WHERE turn_id = ? AND state = 'running'
               AND owner_epoch = ? AND attempt = ?
               AND admission_state = 'unclassified'`,
          )
          .run(
            input.state,
            decisionJson,
            admissionHash,
            submissionJson,
            submissionHash,
            nowIso(),
            claim.itemId,
            claim.ownerEpoch,
            claim.attempt,
          );
        if (committed.changes === 1) {
          db.prepare(`UPDATE messages SET disposition = ? WHERE id = ?`).run(
            input.state,
            owned.inbound_message_id,
          );
        }
      }
      const current = getTurnRow(db, claim.itemId);
      return current ? admissionFromRow(current) : null;
    })
    .immediate();
}

export function touchClaimedChatInboxItem(
  agentDir: string,
  item: ClaimedChatInboxItem,
  options: { leaseMs?: number; nowMs?: number } = {},
) {
  const claim = requireClaim(item);
  const nowMs = Number(options.nowMs ?? Date.now());
  const timestamp = new Date(nowMs).toISOString();
  const leaseUntil = new Date(
    nowMs + Math.max(1, Number(options.leaseMs || DEFAULT_CHAT_INBOX_LEASE_MS)),
  ).toISOString();
  const result = openChatDatabase(agentDir)
    .prepare(
      `UPDATE inbox_jobs
     SET lease_until = ?, heartbeat_at = ?, updated_at = ?
     WHERE turn_id = ? AND state = 'running' AND owner_epoch = ? AND attempt = ?`,
    )
    .run(
      leaseUntil,
      timestamp,
      timestamp,
      claim.itemId,
      claim.ownerEpoch,
      claim.attempt,
    );
  return result.changes === 1;
}

export function completeClaimedChatInboxItem(
  agentDir: string,
  item: ClaimedChatInboxItem,
  options: {
    terminalKind?: string;
    disposition?: "record_only" | "actionable";
  } = {},
) {
  const claim = requireClaim(item);
  const db = openChatDatabase(agentDir);
  return db
    .transaction(() => {
      const current = getTurnRow(db, claim.itemId);
      if (current?.state === "terminal") return true;
      const timestamp = nowIso();
      const result = db
        .prepare(
          `UPDATE inbox_jobs
         SET state = 'terminal', terminal_kind = ?, owner_epoch = NULL,
             lease_until = NULL, heartbeat_at = NULL, next_attempt_at = NULL,
             last_error = NULL, updated_at = ?
         WHERE turn_id = ? AND state = 'running' AND owner_epoch = ? AND attempt = ?`,
        )
        .run(
          safeString(options.terminalKind).trim() || "completed",
          timestamp,
          claim.itemId,
          claim.ownerEpoch,
          claim.attempt,
        );
      if (result.changes !== 1) return false;
      db.prepare(
        `UPDATE messages
         SET disposition = CASE
           WHEN (
             SELECT admission_state FROM inbox_jobs WHERE turn_id = ?
           ) IN ('actionable', 'record_only') THEN (
             SELECT admission_state FROM inbox_jobs WHERE turn_id = ?
           )
           ELSE ?
         END
         WHERE id = (SELECT inbound_message_id FROM inbox_jobs WHERE turn_id = ?)`,
      ).run(
        claim.itemId,
        claim.itemId,
        options.disposition || "actionable",
        claim.itemId,
      );
      return true;
    })
    .immediate();
}

export function failClaimedChatInboxItem(
  agentDir: string,
  item: ClaimedChatInboxItem,
  error?: string,
) {
  const claim = requireClaim(item);
  const timestamp = nowIso();
  const result = openChatDatabase(agentDir)
    .prepare(
      `UPDATE inbox_jobs
     SET state = 'failed', terminal_kind = 'interrupted',
         owner_epoch = NULL, lease_until = NULL, heartbeat_at = NULL,
         next_attempt_at = NULL, last_error = ?, updated_at = ?
     WHERE turn_id = ? AND state = 'running' AND owner_epoch = ? AND attempt = ?`,
    )
    .run(
      safeString(error).trim() || null,
      timestamp,
      claim.itemId,
      claim.ownerEpoch,
      claim.attempt,
    );
  return result.changes === 1 ? getChatInboxItem(agentDir, claim.itemId) : null;
}

export function interruptProcessingChatInboxItems(
  agentDir: string,
  options: { nowMs?: number; limit?: number } = {},
) {
  const db = openChatDatabase(agentDir);
  const timestamp = new Date(Number(options.nowMs ?? Date.now())).toISOString();
  const limit = Math.max(0, Math.floor(Number(options.limit || 0)));
  return db
    .transaction(() => {
      const rows = db
        .prepare(
          `${INBOX_SELECT}
         WHERE inbox_jobs.state = 'running'
           AND (inbox_jobs.lease_until IS NULL OR inbox_jobs.lease_until <= ?)
         ORDER BY inbox_jobs.sequence, inbox_jobs.turn_id
         ${limit ? `LIMIT ${limit}` : ""}`,
        )
        .all(timestamp) as any[];
      const restored: RestoredChatInboxProcessingItem[] = [];
      for (const row of rows) {
        const result = db
          .prepare(
            `UPDATE inbox_jobs
           SET state = 'failed', terminal_kind = 'interrupted',
               owner_epoch = NULL, lease_until = NULL,
               heartbeat_at = NULL, next_attempt_at = NULL,
               last_error = 'chat_turn_interrupted', updated_at = ?
           WHERE turn_id = ? AND state = 'running'
             AND (lease_until IS NULL OR lease_until <= ?)`,
          )
          .run(timestamp, row.turn_id, timestamp);
        if (result.changes === 1) {
          restored.push({
            itemId: safeString(row.turn_id),
            chatKey: safeString(row.chat_key),
            messageId: safeString(row.message_id),
          });
        }
      }
      return restored;
    })
    .immediate();
}

function asRecord(value: unknown): Record<string, any> {
  return isJsonRecord(value) ? value : {};
}

function pickTrimmedString(...values: unknown[]) {
  for (const value of values) {
    const text = safeString(value).trim();
    if (text) return text;
  }
  return undefined;
}

function mergeSessionRecord(
  session: Record<string, any>,
  key: string,
  patch: Record<string, unknown>,
) {
  const next = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );
  if (!Object.keys(next).length) return;
  session[key] = { ...asRecord(session[key]), ...next };
}

export function restoreChatInboxElements(item: ChatInboxItem) {
  const session = asRecord(cloneJsonIfObject(item?.session) ?? {});
  const quote = isJsonRecord(session.quote)
    ? session.quote
    : { messageId: item?.routing?.replyToMessageId };
  return migrateLegacyQuoteToElements(
    quote,
    cloneJson(Array.isArray(item?.elements) ? item.elements : []),
  );
}

export function restoreChatInboxSession(item: ChatInboxItem, bot?: any) {
  const restored = asRecord(cloneJsonIfObject(item?.session) ?? {});
  const { quote: _legacyQuote, ...session } = restored;
  const routing =
    item?.routing && typeof item.routing === "object" ? item.routing : null;
  if (bot) session.bot = bot;
  if (!routing) return session;
  session.isDirect = Boolean(routing.isDirect);
  session.userId = pickTrimmedString(session.userId, routing.userId);
  if (routing.text || routing.mentionLike) {
    mergeSessionRecord(session, "stripped", {
      content: routing.text
        ? pickTrimmedString(session?.stripped?.content, routing.text)
        : undefined,
      appel: routing.mentionLike ? true : undefined,
    });
  }
  if (routing.nickname) {
    mergeSessionRecord(session, "author", {
      name: pickTrimmedString(session?.author?.name, routing.nickname),
    });
  }
  if (routing.chatName) {
    session.channelName = pickTrimmedString(
      session?.channelName,
      routing.chatName,
    );
  }
  return session;
}
