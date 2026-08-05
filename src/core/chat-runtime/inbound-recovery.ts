import { openChatDatabase } from "../chat/database.js";
import { composeChatKey } from "../chat/support.js";
import { safeString } from "../text-utils.js";

export type InboundRecoveryHead = {
  chatKey: string;
  chatId: string;
  messageId: string;
  platformTimestamp: number;
  providerCursor?: string;
  failureCount?: number;
  firstFailedAt?: string;
  lastFailedAt?: string;
  pausedAt?: string;
  nextAttemptAt?: string;
  recoveryVersion?: number;
};

export type InboundRecoveryLeasePolicy = {
  minFailures: number;
  minFailureAgeMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  maxRetirements: number;
};

const activeRecoveryAttempts = new Map<string, number>();

export const DEFAULT_INBOUND_RECOVERY_LEASE_POLICY: InboundRecoveryLeasePolicy =
  {
    minFailures: 3,
    minFailureAgeMs: 24 * 60 * 60 * 1000,
    retryBaseMs: 60 * 60 * 1000,
    retryMaxMs: 8 * 60 * 60 * 1000,
    maxRetirements: 100,
  };

export type InboundRecoveryGateEntry<T> = {
  key: string;
  item: T;
};

export class InboundRecoveryGate<T> {
  private discovering = false;
  private readonly recoveringKeys = new Set<string>();
  private entries: Array<InboundRecoveryGateEntry<T>> = [];

  begin() {
    this.discovering = true;
    this.recoveringKeys.clear();
  }

  configure(keys: Iterable<string>) {
    this.discovering = false;
    this.recoveringKeys.clear();
    for (const key of keys) {
      const normalized = safeString(key).trim();
      if (normalized) this.recoveringKeys.add(normalized);
    }
    const readyKeys: string[] = [];
    const seenReadyKeys = new Set<string>();
    for (const entry of this.entries) {
      if (this.recoveringKeys.has(entry.key)) continue;
      this.recoveringKeys.add(entry.key);
      if (!seenReadyKeys.has(entry.key)) {
        seenReadyKeys.add(entry.key);
        readyKeys.push(entry.key);
      }
    }
    return readyKeys;
  }

  buffer(key: string, item: T) {
    const normalized = safeString(key).trim();
    if (!this.discovering && !this.recoveringKeys.has(normalized)) return false;
    this.entries.push({ key: normalized, item });
    return true;
  }

  drain(key: string) {
    const normalized = safeString(key).trim();
    const drained: T[] = [];
    const pending: Array<InboundRecoveryGateEntry<T>> = [];
    for (const entry of this.entries) {
      if (entry.key === normalized) drained.push(entry.item);
      else pending.push(entry);
    }
    this.entries = pending;
    return drained;
  }

  prepend(key: string, items: T[]) {
    if (!items.length) return;
    const normalized = safeString(key).trim();
    this.recoveringKeys.add(normalized);
    this.entries.unshift(...items.map((item) => ({ key: normalized, item })));
  }

  hasPending(key?: string) {
    if (key === undefined) return this.entries.length > 0;
    const normalized = safeString(key).trim();
    return this.entries.some((entry) => entry.key === normalized);
  }

  open(key: string) {
    const normalized = safeString(key).trim();
    if (this.hasPending(normalized)) {
      throw new Error(
        `Inbound recovery gate still has buffered messages for ${normalized}`,
      );
    }
    this.recoveringKeys.delete(normalized);
  }

  isBuffering(key?: string) {
    if (key === undefined) {
      return this.discovering || this.recoveringKeys.size > 0;
    }
    const normalized = safeString(key).trim();
    return this.discovering || this.recoveringKeys.has(normalized);
  }
}

function recoveryTimestamp(record: any) {
  const platformTimestamp = Number(record?.platformTimestamp);
  if (Number.isFinite(platformTimestamp) && platformTimestamp > 0) {
    return platformTimestamp;
  }
  const receivedAt = Date.parse(safeString(record?.receivedAt).trim());
  return Number.isFinite(receivedAt) ? receivedAt : 0;
}

export function listInboundRecoveryHeads(
  agentDir: string,
  platform: string,
  botId: string,
  options: { includeLeaseState?: boolean } = {},
): InboundRecoveryHead[] {
  const nextPlatform = safeString(platform).trim();
  const nextBotId = safeString(botId).trim();
  if (!nextPlatform || !nextBotId) return [];
  const rows = openChatDatabase(agentDir)
    .prepare(
      `SELECT chat_key, chat_id, message_id, platform_timestamp,
              received_at, provider_cursor, recovery_failure_count,
              recovery_first_failed_at, recovery_last_failed_at,
              recovery_paused_at, recovery_next_attempt_at, recovery_version
       FROM inbound_heads
       WHERE platform = ? AND bot_id = ?
       ORDER BY chat_key`,
    )
    .all(nextPlatform, nextBotId) as any[];
  return rows
    .map((row) => {
      const chatKey = safeString(row.chat_key).trim();
      const chatId = safeString(row.chat_id).trim();
      const messageId = safeString(row.message_id).trim();
      if (
        !chatKey ||
        !chatId ||
        !messageId ||
        chatKey !== composeChatKey(nextPlatform, chatId, nextBotId)
      ) {
        return null;
      }
      const platformTimestamp = recoveryTimestamp({
        platformTimestamp: row.platform_timestamp,
        receivedAt: row.received_at,
      });
      const providerCursor = safeString(row.provider_cursor).trim();
      const leaseState = options.includeLeaseState
        ? {
            failureCount: Math.max(0, Number(row.recovery_failure_count || 0)),
            ...(safeString(row.recovery_first_failed_at).trim()
              ? {
                  firstFailedAt: safeString(
                    row.recovery_first_failed_at,
                  ).trim(),
                }
              : {}),
            ...(safeString(row.recovery_last_failed_at).trim()
              ? {
                  lastFailedAt: safeString(row.recovery_last_failed_at).trim(),
                }
              : {}),
            ...(safeString(row.recovery_paused_at).trim()
              ? {
                  pausedAt: safeString(row.recovery_paused_at).trim(),
                }
              : {}),
            ...(safeString(row.recovery_next_attempt_at).trim()
              ? {
                  nextAttemptAt: safeString(
                    row.recovery_next_attempt_at,
                  ).trim(),
                }
              : {}),
            recoveryVersion: Math.max(0, Number(row.recovery_version || 0)),
          }
        : {};
      return {
        chatKey,
        chatId,
        messageId,
        platformTimestamp,
        ...(providerCursor ? { providerCursor } : {}),
        ...leaseState,
      };
    })
    .filter((item): item is InboundRecoveryHead => Boolean(item));
}

export function deleteInboundRecoveryHeads(
  agentDir: string,
  platform: string,
  botId: string,
  chatKey?: string,
) {
  const nextPlatform = safeString(platform).trim();
  const nextBotId = safeString(botId).trim();
  const nextChatKey = safeString(chatKey).trim();
  if (!nextPlatform || !nextBotId) return 0;
  const db = openChatDatabase(agentDir);
  const result = nextChatKey
    ? db
        .prepare(
          `DELETE FROM inbound_heads
           WHERE platform = ? AND bot_id = ? AND chat_key = ?`,
        )
        .run(nextPlatform, nextBotId, nextChatKey)
    : db
        .prepare(`DELETE FROM inbound_heads WHERE platform = ? AND bot_id = ?`)
        .run(nextPlatform, nextBotId);
  return Number(result.changes || 0);
}

function normalizedRecoveryPolicy(
  input: Partial<InboundRecoveryLeasePolicy> = {},
): InboundRecoveryLeasePolicy {
  const positive = (value: unknown, fallback: number) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  };
  const retryBaseMs = positive(
    input.retryBaseMs,
    DEFAULT_INBOUND_RECOVERY_LEASE_POLICY.retryBaseMs,
  );
  return {
    minFailures: Math.max(
      1,
      Math.floor(
        positive(
          input.minFailures,
          DEFAULT_INBOUND_RECOVERY_LEASE_POLICY.minFailures,
        ),
      ),
    ),
    minFailureAgeMs: positive(
      input.minFailureAgeMs,
      DEFAULT_INBOUND_RECOVERY_LEASE_POLICY.minFailureAgeMs,
    ),
    retryBaseMs,
    retryMaxMs: Math.max(
      retryBaseMs,
      positive(
        input.retryMaxMs,
        DEFAULT_INBOUND_RECOVERY_LEASE_POLICY.retryMaxMs,
      ),
    ),
    maxRetirements: Math.max(
      0,
      Math.floor(
        positive(
          input.maxRetirements,
          DEFAULT_INBOUND_RECOVERY_LEASE_POLICY.maxRetirements,
        ),
      ),
    ),
  };
}

function recoveryAttemptIdentity(
  agentDir: string,
  platform: string,
  botId: string,
  head: InboundRecoveryHead,
) {
  return [
    agentDir,
    platform,
    botId,
    head.chatKey,
    head.messageId,
    safeString(head.providerCursor).trim(),
  ].join("\u0000");
}

function recoveryHeadCursorMatchesSql() {
  return `platform = @platform AND bot_id = @bot_id AND chat_key = @chat_key
    AND message_id = @message_id
    AND COALESCE(provider_cursor, '') = @provider_cursor`;
}

function recoveryHeadVersionMatchesSql() {
  return `${recoveryHeadCursorMatchesSql()}
    AND recovery_version = @recovery_version`;
}

function settleInboundRecoveryLeases(
  agentDir: string,
  platform: string,
  botId: string,
  succeeded: InboundRecoveryHead[],
  failed: InboundRecoveryHead[],
  nowMs: number,
  policy: InboundRecoveryLeasePolicy,
  protectedFromRetirement: Set<string>,
) {
  const retired: string[] = [];
  const db = openChatDatabase(agentDir);
  db.transaction(() => {
    const cursorMatchSql = recoveryHeadCursorMatchesSql();
    const versionMatchSql = recoveryHeadVersionMatchesSql();
    const clearFailure = db.prepare(
      `UPDATE inbound_heads
       SET recovery_failure_count = 0,
           recovery_first_failed_at = NULL,
           recovery_last_failed_at = NULL,
           recovery_paused_at = NULL,
           recovery_next_attempt_at = NULL,
           recovery_version = recovery_version + 1
       WHERE ${cursorMatchSql}`,
    );
    const readFailure = db.prepare(
      `SELECT recovery_failure_count, recovery_first_failed_at,
              recovery_paused_at
       FROM inbound_heads WHERE ${versionMatchSql}`,
    );
    const recordFailure = db.prepare(
      `UPDATE inbound_heads
       SET recovery_failure_count = @next_failure_count,
           recovery_first_failed_at = @first_failed_at,
           recovery_last_failed_at = @failed_at,
           recovery_paused_at = NULL,
           recovery_next_attempt_at = @next_attempt_at,
           recovery_version = recovery_version + 1
       WHERE ${versionMatchSql}`,
    );
    const retire = db.prepare(
      `DELETE FROM inbound_heads
       WHERE platform = @platform AND bot_id = @bot_id
         AND chat_key = @chat_key AND message_id = @message_id
         AND COALESCE(provider_cursor, '') = @provider_cursor
         AND recovery_version = @recovery_version
         AND recovery_failure_count = @failure_count`,
    );
    const parameters = (head: InboundRecoveryHead) => ({
      platform,
      bot_id: botId,
      chat_key: head.chatKey,
      message_id: head.messageId,
      provider_cursor: safeString(head.providerCursor).trim(),
      recovery_version: Math.max(0, Number(head.recoveryVersion || 0)),
    });
    for (const head of succeeded) clearFailure.run(parameters(head));
    for (const head of failed) {
      const current = readFailure.get(parameters(head)) as any;
      if (!current) continue;
      const failureCount = Math.max(
        0,
        Number(current.recovery_failure_count || 0),
      );
      const nextFailureCount = failureCount + 1;
      const storedFirstFailedAt = safeString(
        current.recovery_first_failed_at,
      ).trim();
      const storedFirstFailedAtMs = Date.parse(storedFirstFailedAt);
      const pausedAtMs = Date.parse(
        safeString(current.recovery_paused_at).trim(),
      );
      const adjustedFirstFailedAtMs =
        Number.isFinite(storedFirstFailedAtMs) && Number.isFinite(pausedAtMs)
          ? storedFirstFailedAtMs + Math.max(0, nowMs - pausedAtMs)
          : storedFirstFailedAtMs;
      const firstFailedAt = Number.isFinite(adjustedFirstFailedAtMs)
        ? new Date(adjustedFirstFailedAtMs).toISOString()
        : new Date(nowMs).toISOString();
      const failureAgeMs = Math.max(0, nowMs - Date.parse(firstFailedAt));
      const retryDelayMs = Math.min(
        policy.retryMaxMs,
        policy.retryBaseMs * 2 ** Math.min(30, failureCount),
      );
      const nextVersion = Math.max(0, Number(head.recoveryVersion || 0)) + 1;
      const nextParameters = {
        ...parameters(head),
        next_failure_count: nextFailureCount,
        first_failed_at: firstFailedAt,
        failed_at: new Date(nowMs).toISOString(),
        next_attempt_at: new Date(nowMs + retryDelayMs).toISOString(),
      };
      if (recordFailure.run(nextParameters).changes !== 1) continue;
      if (
        nextFailureCount < policy.minFailures ||
        failureAgeMs < policy.minFailureAgeMs ||
        retired.length >= policy.maxRetirements ||
        protectedFromRetirement.has(head.chatKey)
      ) {
        continue;
      }
      const result = retire.run({
        ...nextParameters,
        recovery_version: nextVersion,
        failure_count: nextFailureCount,
      });
      if (result.changes === 1) retired.push(head.chatKey);
    }
  }).immediate();
  return retired;
}

function deferUnhealthyRecoveryScope(
  agentDir: string,
  platform: string,
  botId: string,
  failed: InboundRecoveryHead[],
  nowMs: number,
  policy: InboundRecoveryLeasePolicy,
) {
  const db = openChatDatabase(agentDir);
  db.transaction(() => {
    const update = db.prepare(
      `UPDATE inbound_heads
       SET recovery_paused_at = CASE
             WHEN recovery_first_failed_at IS NOT NULL
             THEN COALESCE(recovery_paused_at, @paused_at)
             ELSE NULL
           END,
           recovery_next_attempt_at = @next_attempt_at,
           recovery_version = recovery_version + 1
       WHERE ${recoveryHeadVersionMatchesSql()}`,
    );
    const retryFailureCount = Math.max(
      0,
      ...failed.map((head) => Math.max(0, Number(head.failureCount || 0))),
    );
    const retryDelayMs = Math.min(
      policy.retryMaxMs,
      policy.retryBaseMs * 2 ** Math.min(30, retryFailureCount),
    );
    for (const head of failed) {
      update.run({
        platform,
        bot_id: botId,
        chat_key: head.chatKey,
        message_id: head.messageId,
        provider_cursor: safeString(head.providerCursor).trim(),
        recovery_version: Math.max(0, Number(head.recoveryVersion || 0)),
        paused_at: new Date(nowMs).toISOString(),
        next_attempt_at: new Date(nowMs + retryDelayMs).toISOString(),
      });
    }
  }).immediate();
}

export type InboundRecoveryHeadOutcome<T> = {
  head: InboundRecoveryHead;
  recovered: T[];
  error?: unknown;
};

export async function recoverInboundHeads<T>(
  agentDir: string,
  platform: string,
  botId: string,
  recover: (head: InboundRecoveryHead) => Promise<T[]>,
  options: {
    nowMs?: number;
    policy?: Partial<InboundRecoveryLeasePolicy>;
    concurrency?: number;
    onHeads?: (heads: InboundRecoveryHead[]) => void | Promise<void>;
    onHeadSettled?: (
      outcome: InboundRecoveryHeadOutcome<T>,
    ) => void | Promise<void>;
  } = {},
) {
  const nowMs = Number.isFinite(Number(options.nowMs))
    ? Number(options.nowMs)
    : Date.now();
  const policy = normalizedRecoveryPolicy(options.policy);
  const allHeads = listInboundRecoveryHeads(agentDir, platform, botId, {
    includeLeaseState: true,
  });
  const heads = allHeads.filter((head) => {
    const nextAttemptAt = Date.parse(safeString(head.nextAttemptAt).trim());
    return !Number.isFinite(nextAttemptAt) || nextAttemptAt <= nowMs;
  });
  await options.onHeads?.(heads);
  const nextPlatform = safeString(platform).trim();
  const nextBotId = safeString(botId).trim();
  const attemptIdentities = new Map(
    heads.map((head) => [
      head,
      recoveryAttemptIdentity(agentDir, nextPlatform, nextBotId, head),
    ]),
  );
  for (const identity of attemptIdentities.values()) {
    activeRecoveryAttempts.set(
      identity,
      (activeRecoveryAttempts.get(identity) || 0) + 1,
    );
  }
  try {
    const outcomes: Array<InboundRecoveryHeadOutcome<T>> = new Array(
      heads.length,
    );
    const callbackErrors: unknown[] = [];
    let nextIndex = 0;
    const requestedConcurrency = Math.floor(Number(options.concurrency || 4));
    const concurrency = Math.max(
      1,
      Math.min(
        heads.length || 1,
        Number.isFinite(requestedConcurrency) ? requestedConcurrency : 4,
      ),
    );
    const runWorker = async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= heads.length) return;
        const head = heads[index];
        let outcome: InboundRecoveryHeadOutcome<T>;
        try {
          outcome = { head, recovered: await recover(head) };
        } catch (error) {
          outcome = { head, recovered: [], error };
        }
        outcomes[index] = outcome;
        try {
          await options.onHeadSettled?.(outcome);
        } catch (error) {
          callbackErrors.push(error);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, runWorker));
    if (callbackErrors.length) throw callbackErrors[0];

    const recovered = outcomes.flatMap((outcome) => outcome.recovered);
    const succeeded = outcomes
      .filter((outcome) => outcome.error === undefined)
      .map((outcome) => outcome.head);
    const failed = outcomes
      .filter((outcome) => outcome.error !== undefined)
      .map((outcome) => {
        const detail = safeString(
          (outcome.error as any)?.message || outcome.error,
        ).trim();
        return { head: outcome.head, detail: detail || "history_failed" };
      });
    // A shared outage is only established when every persisted checkpoint
    // was due, attempted, and failed. Deferred peers make a lone due failure
    // checkpoint-local rather than evidence about the whole adapter scope.
    const scopeHealthy =
      failed.length === 0 ||
      succeeded.length > 0 ||
      heads.length < allHeads.length;
    const protectedFromRetirement = new Set(
      failed
        .filter(
          (entry) =>
            (activeRecoveryAttempts.get(
              attemptIdentities.get(entry.head) || "",
            ) || 0) > 1,
        )
        .map((entry) => entry.head.chatKey),
    );
    const retired = scopeHealthy
      ? settleInboundRecoveryLeases(
          agentDir,
          nextPlatform,
          nextBotId,
          succeeded,
          failed.map((entry) => entry.head),
          nowMs,
          policy,
          protectedFromRetirement,
        )
      : [];
    if (!scopeHealthy) {
      deferUnhealthyRecoveryScope(
        agentDir,
        nextPlatform,
        nextBotId,
        failed.map((entry) => entry.head),
        nowMs,
        policy,
      );
    }
    const retiredSet = new Set(retired);
    const failures = failed
      .filter((entry) => !retiredSet.has(entry.head.chatKey))
      .map((entry) => `${entry.head.chatKey}:${entry.detail}`);
    const failedThisRun = new Set(failed.map((entry) => entry.head.chatKey));
    const deferred = listInboundRecoveryHeads(agentDir, platform, botId, {
      includeLeaseState: true,
    })
      .filter((head) => {
        const nextAttemptAt = Date.parse(safeString(head.nextAttemptAt).trim());
        return (
          !failedThisRun.has(head.chatKey) &&
          Number.isFinite(nextAttemptAt) &&
          nextAttemptAt > nowMs
        );
      })
      .map((head) => head.chatKey);
    return {
      recovered,
      failures,
      deferred,
      retired,
      scopeHealthy,
    };
  } finally {
    for (const identity of attemptIdentities.values()) {
      const count = activeRecoveryAttempts.get(identity) || 0;
      if (count <= 1) activeRecoveryAttempts.delete(identity);
      else activeRecoveryAttempts.set(identity, count - 1);
    }
  }
}

export function applyInboundRecoveryResult(
  bot: any,
  logger: any,
  result: {
    failures: string[];
    deferred: string[];
    retired: string[];
  },
) {
  if (result.retired.length) {
    logger?.info?.(
      `inbound recovery retired checkpoints=${JSON.stringify(result.retired)}`,
    );
  }
  const pending = [
    ...result.failures,
    ...result.deferred.map((chatKey) => `${chatKey}:recovery_deferred`),
  ];
  bot.inboundRecovery = pending.length
    ? { status: "degraded", failures: pending }
    : { status: "ready" };
  if (result.failures.length) {
    logger?.warn?.(
      `inbound recovery degraded failures=${JSON.stringify(result.failures)}`,
    );
  }
}

function sessionIdentity(session: any) {
  const platform = safeString(session?.platform).trim();
  const botId = safeString(session?.selfId || session?.bot?.selfId).trim();
  const chatId = safeString(
    session?.channelId || session?.chatId || session?.guildId,
  ).trim();
  const messageId = safeString(
    session?.messageId || session?.id || session?.eventId,
  ).trim();
  return platform && botId && chatId && messageId
    ? `${platform}\u0000${botId}\u0000${chatId}\u0000${messageId}`
    : "";
}

function sessionTimestamp(session: any) {
  const timestamp = Number(session?.timestamp);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

export function mergeInboundRecoverySessions(
  recovered: any[],
  bufferedLive: any[],
) {
  const entries = [
    ...(Array.isArray(recovered) ? recovered : []).map((session, index) => ({
      session,
      timestamp: sessionTimestamp(session),
      sourceOrder: 0,
      index,
    })),
    ...(Array.isArray(bufferedLive) ? bufferedLive : []).map(
      (session, index) => ({
        session,
        timestamp: sessionTimestamp(session),
        sourceOrder: 1,
        index,
      }),
    ),
  ];
  const deduped = new Map<string, (typeof entries)[number]>();
  const anonymous: typeof entries = [];
  for (const entry of entries) {
    const identity = sessionIdentity(entry.session);
    if (!identity) {
      anonymous.push(entry);
      continue;
    }
    const current = deduped.get(identity);
    if (!current) {
      deduped.set(identity, entry);
      continue;
    }
    if (entry.sourceOrder > current.sourceOrder) {
      current.session = entry.session;
    }
  }
  return [...deduped.values(), ...anonymous]
    .sort(
      (left, right) =>
        left.timestamp - right.timestamp ||
        left.sourceOrder - right.sourceOrder ||
        left.index - right.index,
    )
    .map((entry) => entry.session);
}
