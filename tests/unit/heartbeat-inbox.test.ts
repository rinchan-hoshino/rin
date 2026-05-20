import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appendHeartbeatChatReadEntry,
  listUnreadHeartbeatInboxEntries,
  markHeartbeatInboxEntriesRead,
} from "../../src/core/heartbeat/inbox.ts";
import { isHeartbeatChatEnabled } from "../../src/core/heartbeat/config.ts";

test("heartbeat chat read entries dedupe by chat and hour", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-heartbeat-"));
  try {
    const chatKey = "telegram/123:456";
    const firstHour = Date.parse("2026-05-14T12:10:00.000Z");
    const sameHour = Date.parse("2026-05-14T12:55:00.000Z");
    const nextHour = Date.parse("2026-05-14T13:00:00.000Z");

    const first = appendHeartbeatChatReadEntry(agentDir, {
      chatKey,
      chatName: "Demo Chat",
      nowMs: firstHour,
    });
    const second = appendHeartbeatChatReadEntry(agentDir, {
      chatKey,
      chatName: "Demo Chat",
      nowMs: sameHour,
    });
    assert.equal(first.entry.id, second.entry.id);
    assert.equal(listUnreadHeartbeatInboxEntries(agentDir).length, 1);
    assert.match(first.entry.title, /Demo Chat/);

    markHeartbeatInboxEntriesRead(agentDir, {
      entryIds: [first.entry.id],
      actorId: "builtin_personality_heartbeat",
      result: "reviewed",
    });
    assert.equal(listUnreadHeartbeatInboxEntries(agentDir).length, 0);

    appendHeartbeatChatReadEntry(agentDir, {
      chatKey,
      chatName: "Demo Chat",
      nowMs: sameHour,
    });
    assert.equal(listUnreadHeartbeatInboxEntries(agentDir).length, 0);

    appendHeartbeatChatReadEntry(agentDir, {
      chatKey,
      chatName: "Demo Chat",
      nowMs: nextHour,
    });
    assert.equal(listUnreadHeartbeatInboxEntries(agentDir).length, 1);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("heartbeat chat whitelist is explicit", () => {
  assert.equal(
    isHeartbeatChatEnabled(
      { chat: { heartbeat: { chats: ["telegram/123:456"] } } },
      "telegram/123:456",
    ),
    true,
  );
  assert.equal(
    isHeartbeatChatEnabled(
      { chat: { heartbeat: { chats: ["telegram/123:456"] } } },
      "telegram/other:456",
    ),
    false,
  );
});
