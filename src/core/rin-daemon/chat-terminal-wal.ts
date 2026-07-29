import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { safeString } from "../text-utils.js";

export type ChatTerminalWalRecord = {
  version: 1;
  state: "staged" | "committed";
  runId: string;
  ownerEpoch: string;
  producerIncarnation: string;
  terminalKind: "complete" | "error";
  terminalPayload: Record<string, unknown>;
  payloadHash: string;
  stagedAt: string;
  committedAt?: string;
  outboxId?: string;
};

export type StageChatTerminalWalInput = {
  runId: string;
  ownerEpoch: string;
  producerIncarnation: string;
  terminalKind: "complete" | "error";
  terminalPayload: Record<string, unknown>;
};

function requiredText(value: unknown, error: string) {
  const text = safeString(value).trim();
  if (!text) throw new Error(error);
  return text;
}

function terminalWalDir(agentDir: string) {
  return path.join(agentDir, "data", "chat", "terminal-wal");
}

function terminalWalPath(agentDir: string, runId: string) {
  const name = createHash("sha256").update(runId).digest("hex");
  return path.join(terminalWalDir(agentDir), `${name}.json`);
}

function payloadHash(input: StageChatTerminalWalInput) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        runId: input.runId,
        ownerEpoch: input.ownerEpoch,
        producerIncarnation: input.producerIncarnation,
        terminalKind: input.terminalKind,
        terminalPayload: input.terminalPayload,
      }),
    )
    .digest("hex");
}

function fsyncDirectory(directory: string) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensureTerminalWalDirectory(agentDir: string) {
  const directory = terminalWalDir(agentDir);
  const missing: string[] = [];
  let cursor = directory;
  while (!fs.existsSync(cursor)) {
    missing.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  for (const candidate of missing.reverse()) {
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
    } catch (error: any) {
      if (safeString(error?.code) !== "EEXIST") throw error;
    }
    fsyncDirectory(path.dirname(candidate));
  }
  try {
    fs.chmodSync(directory, 0o700);
  } catch {}
  return directory;
}

function writeRecord(agentDir: string, record: ChatTerminalWalRecord) {
  const directory = ensureTerminalWalDirectory(agentDir);
  const target = terminalWalPath(agentDir, record.runId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, target);
    fsyncDirectory(directory);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {}
    throw error;
  }
}

function parseRecord(raw: string): ChatTerminalWalRecord {
  const parsed = JSON.parse(raw) as ChatTerminalWalRecord;
  if (
    parsed?.version !== 1 ||
    !["staged", "committed"].includes(parsed.state) ||
    !safeString(parsed.runId).trim() ||
    !safeString(parsed.ownerEpoch).trim() ||
    !safeString(parsed.producerIncarnation).trim() ||
    !["complete", "error"].includes(parsed.terminalKind) ||
    !parsed.terminalPayload ||
    typeof parsed.terminalPayload !== "object" ||
    Array.isArray(parsed.terminalPayload) ||
    !safeString(parsed.payloadHash).match(/^[0-9a-f]{64}$/) ||
    parsed.payloadHash !== payloadHash(parsed)
  ) {
    throw new Error("chat_terminal_wal_invalid");
  }
  return parsed;
}

export function listStagedChatTerminalWal(
  agentDir: string,
  options: { sessionFile?: string; sessionId?: string } = {},
): ChatTerminalWalRecord[] {
  const directory = terminalWalDir(agentDir);
  let files: string[];
  try {
    files = fs.readdirSync(directory).filter((file) => file.endsWith(".json"));
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const expectedSessionFile = safeString(options.sessionFile).trim();
  const expectedSessionId = safeString(options.sessionId).trim();
  return files
    .map((file) =>
      parseRecord(fs.readFileSync(path.join(directory, file), "utf8")),
    )
    .filter((record) => record.state === "staged")
    .filter(
      (record) =>
        (!expectedSessionFile ||
          safeString(record.terminalPayload.sessionFile).trim() ===
            expectedSessionFile) &&
        (!expectedSessionId ||
          safeString(record.terminalPayload.sessionId).trim() ===
            expectedSessionId),
    )
    .sort((left, right) => left.stagedAt.localeCompare(right.stagedAt));
}

export function readChatTerminalWal(
  agentDir: string,
  runId: string,
): ChatTerminalWalRecord | undefined {
  const requiredRunId = requiredText(runId, "chat_terminal_wal_missing_run_id");
  const file = terminalWalPath(agentDir, requiredRunId);
  try {
    const record = parseRecord(fs.readFileSync(file, "utf8"));
    if (record.runId !== requiredRunId) {
      throw new Error("chat_terminal_wal_identity_mismatch");
    }
    return record;
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export function stageChatTerminalWal(
  agentDir: string,
  candidate: StageChatTerminalWalInput,
): ChatTerminalWalRecord {
  const normalized: StageChatTerminalWalInput = {
    runId: requiredText(candidate.runId, "chat_terminal_wal_missing_run_id"),
    ownerEpoch: requiredText(
      candidate.ownerEpoch,
      "chat_terminal_wal_missing_owner_epoch",
    ),
    producerIncarnation: requiredText(
      candidate.producerIncarnation,
      "chat_terminal_wal_missing_producer_incarnation",
    ),
    terminalKind: candidate.terminalKind,
    terminalPayload: candidate.terminalPayload,
  };
  if (!["complete", "error"].includes(normalized.terminalKind)) {
    throw new Error("chat_terminal_wal_invalid_kind");
  }
  if (
    !normalized.terminalPayload ||
    typeof normalized.terminalPayload !== "object" ||
    Array.isArray(normalized.terminalPayload)
  ) {
    throw new Error("chat_terminal_wal_invalid_payload");
  }
  const hash = payloadHash(normalized);
  const existing = readChatTerminalWal(agentDir, normalized.runId);
  if (existing) {
    if (
      existing.ownerEpoch !== normalized.ownerEpoch ||
      existing.producerIncarnation !== normalized.producerIncarnation ||
      existing.payloadHash !== hash
    ) {
      throw new Error("chat_terminal_wal_conflict");
    }
    return existing;
  }
  const record: ChatTerminalWalRecord = {
    version: 1,
    state: "staged",
    ...normalized,
    payloadHash: hash,
    stagedAt: new Date().toISOString(),
  };
  writeRecord(agentDir, record);
  return record;
}

export function verifyChatTerminalWal(
  agentDir: string,
  input: {
    runId: string;
    ownerEpoch: string;
    producerIncarnation: string;
    payloadHash: string;
  },
): ChatTerminalWalRecord {
  const record = readChatTerminalWal(agentDir, input.runId);
  if (!record) throw new Error("chat_terminal_wal_missing");
  if (
    record.ownerEpoch !== input.ownerEpoch ||
    record.producerIncarnation !== input.producerIncarnation
  ) {
    throw new Error("chat_terminal_wal_stale_producer");
  }
  if (record.payloadHash !== input.payloadHash) {
    throw new Error("chat_terminal_wal_hash_mismatch");
  }
  return record;
}

export function commitChatTerminalWal(
  agentDir: string,
  input: {
    runId: string;
    ownerEpoch: string;
    producerIncarnation: string;
    payloadHash: string;
    outboxId: string;
  },
): ChatTerminalWalRecord {
  const record = verifyChatTerminalWal(agentDir, input);
  const outboxId = requiredText(
    input.outboxId,
    "chat_terminal_wal_missing_outbox_id",
  );
  if (record.state === "committed") {
    if (record.outboxId !== outboxId) {
      throw new Error("chat_terminal_wal_commit_conflict");
    }
    return record;
  }
  const committed: ChatTerminalWalRecord = {
    ...record,
    state: "committed",
    outboxId,
    committedAt: new Date().toISOString(),
  };
  writeRecord(agentDir, committed);
  return committed;
}
