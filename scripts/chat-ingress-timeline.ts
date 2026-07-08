#!/usr/bin/env tsx
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function argValue(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || "";
  const prefix = `${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : "";
}

function hasFlag(name: string) {
  return process.argv.includes(name);
}

function safeString(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readJson(file: string) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function walkJsonFiles(root: string) {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && entry.name.endsWith(".json")) out.push(file);
    }
  }
  return out;
}

function parseTime(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = safeString(value).trim();
  if (!text) return NaN;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function iso(ms: number) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function secondsBetween(later: number, earlier: number) {
  if (!Number.isFinite(later) || !Number.isFinite(earlier)) return "";
  return ((later - earlier) / 1000).toFixed(1);
}

function maxFinite(...values: number[]) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : NaN;
}

function truncate(value: string, width: number) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= width
    ? text
    : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function key(chatKey: string, messageId: string) {
  return `${chatKey}\u0000${messageId}`;
}

function normalizePlatform(value: unknown) {
  const platform = safeString(value).trim().toLowerCase();
  return platform === "feishu" ? "lark" : platform;
}

type TimelineRow = {
  source: "inbox" | "store";
  state: string;
  chatKey: string;
  messageId: string;
  platform: string;
  platformAt: number;
  receivedAt: number;
  acceptedAt: number;
  processedAt: number;
  inboxCreatedAt: number;
  inboxUpdatedAt: number;
  text: string;
};

const agentDir = path.resolve(
  argValue("--agent-dir") ||
    process.env.RIN_DIR ||
    path.join(os.homedir(), ".rin"),
);
const sinceArg = argValue("--since");
const since = sinceArg ? parseTime(sinceArg) : Date.now() - 6 * 60 * 60 * 1000;
const limit = Math.max(1, Number(argValue("--limit") || 80) || 80);
const platformFilter = normalizePlatform(argValue("--platform"));
const chatKeyFilter = argValue("--chat-key");

if (hasFlag("--help")) {
  console.log(
    `Usage: tsx scripts/chat-ingress-timeline.ts [options]\n\nOptions:\n  --agent-dir DIR      Rin agent dir (default: $RIN_DIR or ~/.rin)\n  --since ISO          Include rows after this time (default: last 6h)\n  --platform NAME      Filter platform, e.g. lark/feishu, discord, telegram\n  --chat-key KEY       Filter exact chat key\n  --limit N            Max rows (default: 80)\n`,
  );
  process.exit(0);
}

const rows = new Map<string, TimelineRow>();

const storeRoot = path.join(
  agentDir,
  "data",
  "chat",
  "message-store",
  "records",
);
for (const file of walkJsonFiles(storeRoot)) {
  const record = readJson(file);
  if (!record) continue;
  const chatKey = safeString(record.chatKey).trim();
  const messageId = safeString(record.messageId).trim();
  if (!chatKey || !messageId) continue;
  const row: TimelineRow = {
    source: "store",
    state: "store",
    chatKey,
    messageId,
    platform: normalizePlatform(record.platform || chatKey.split("/")[0]),
    platformAt: parseTime(record.platformTimestamp),
    receivedAt: parseTime(record.receivedAt),
    acceptedAt: parseTime(record.acceptedAt),
    processedAt: parseTime(record.processedAt),
    inboxCreatedAt: NaN,
    inboxUpdatedAt: parseTime(record.updatedAt),
    text: safeString(
      record.text || record.strippedContent || record.rawContent,
    ),
  };
  rows.set(key(chatKey, messageId), row);
}

const inboxRoot = path.join(agentDir, "data", "chat", "inbox");
for (const state of ["pending", "processing", "completed", "failed"]) {
  for (const file of walkJsonFiles(path.join(inboxRoot, state))) {
    const item = readJson(file);
    if (!item) continue;
    const chatKey = safeString(item.chatKey).trim();
    const messageId = safeString(
      item.messageId || item.session?.messageId,
    ).trim();
    if (!chatKey || !messageId) continue;
    const existing = rows.get(key(chatKey, messageId));
    const platform = normalizePlatform(
      item.session?.platform || chatKey.split("/")[0],
    );
    const platformAt = parseTime(item.session?.timestamp);
    const next: TimelineRow = {
      source: existing ? existing.source : "inbox",
      state,
      chatKey,
      messageId,
      platform: existing?.platform || platform,
      platformAt: Number.isFinite(existing?.platformAt)
        ? existing!.platformAt
        : platformAt,
      receivedAt: existing?.receivedAt ?? NaN,
      acceptedAt: existing?.acceptedAt ?? NaN,
      processedAt: existing?.processedAt ?? NaN,
      inboxCreatedAt: parseTime(item.createdAt),
      inboxUpdatedAt: parseTime(item.updatedAt),
      text: safeString(
        existing?.text || item.routing?.text || item.session?.content,
      ),
    };
    rows.set(key(chatKey, messageId), next);
  }
}

const filtered = [...rows.values()]
  .filter((row) => {
    if (platformFilter && row.platform !== platformFilter) return false;
    if (chatKeyFilter && row.chatKey !== chatKeyFilter) return false;
    const latest = maxFinite(
      row.platformAt,
      row.receivedAt,
      row.acceptedAt,
      row.processedAt,
      row.inboxCreatedAt,
      row.inboxUpdatedAt,
    );
    return Number.isFinite(latest) && latest >= since;
  })
  .sort((a, b) => {
    const atA = maxFinite(
      a.platformAt,
      a.receivedAt,
      a.acceptedAt,
      a.inboxCreatedAt,
    );
    const atB = maxFinite(
      b.platformAt,
      b.receivedAt,
      b.acceptedAt,
      b.inboxCreatedAt,
    );
    return atA - atB;
  })
  .slice(-limit);

console.log(`agentDir=${agentDir}`);
console.log(
  `since=${iso(since)} limit=${limit} platform=${platformFilter || "*"}`,
);
console.log(
  [
    "state".padEnd(10),
    "platform".padEnd(9),
    "chatKey".padEnd(46),
    "messageId".padEnd(22),
    "platformAt".padEnd(24),
    "inboxAt".padEnd(24),
    "acceptedAt".padEnd(24),
    "processedAt".padEnd(24),
    "p->inbox(s)".padStart(11),
    "inbox->proc(s)".padStart(14),
    "text",
  ].join("  "),
);
for (const row of filtered) {
  console.log(
    [
      row.state.padEnd(10),
      row.platform.padEnd(9),
      truncate(row.chatKey, 46).padEnd(46),
      truncate(row.messageId, 22).padEnd(22),
      iso(row.platformAt).padEnd(24),
      iso(row.inboxCreatedAt).padEnd(24),
      iso(row.acceptedAt).padEnd(24),
      iso(row.processedAt).padEnd(24),
      secondsBetween(row.inboxCreatedAt, row.platformAt).padStart(11),
      secondsBetween(row.processedAt, row.inboxCreatedAt).padStart(14),
      truncate(row.text, 80),
    ].join("  "),
  );
}

if (!filtered.length) {
  console.log("No matching chat timeline rows found.");
}
