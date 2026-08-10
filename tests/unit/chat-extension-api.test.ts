import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  closeChatDatabase,
  openChatDatabase,
  writeChatSessionBinding,
} from "../../dist/core/chat/database.js";
import { createDaemonChatAPI } from "../../dist/core/chat/extension-api.js";

test("daemon chat API owns chat discovery and current session bindings only", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-chat-api-"));
  try {
    writeChatSessionBinding(
      agentDir,
      "discord/1:10",
      path.join(agentDir, "sessions", "current.jsonl"),
    );
    writeChatSessionBinding(
      agentDir,
      "discord/2:20",
      path.join(agentDir, "sessions", "other.jsonl"),
    );
    writeChatSessionBinding(
      agentDir,
      "telegram/1:30",
      path.join(agentDir, "sessions", "telegram.jsonl"),
    );

    openChatDatabase(agentDir)
      .prepare("INSERT INTO chat_state (chat_key, updated_at) VALUES (?, ?)")
      .run("invalid-chat-key", new Date().toISOString());

    const api = createDaemonChatAPI({ agentDir });
    assert.deepEqual(await api.listKeys(), [
      "discord/1:10",
      "discord/2:20",
      "telegram/1:30",
    ]);
    assert.deepEqual(
      await api.listKeys({ platform: "discord", accountIds: ["", "1"] }),
      ["discord/1:10"],
    );
    assert.deepEqual(
      await api.listKeys({ platform: "telegram", accountIds: [] }),
      ["telegram/1:30"],
    );

    const [binding, missing] = await api.getSessionBindings([
      "discord/1:10",
      "discord/1:missing",
    ]);
    assert.match(binding?.token || "", /^rin-session-v1:/);
    assert.equal(binding?.token.includes(agentDir), false);
    assert.equal(missing, null);
  } finally {
    closeChatDatabase(agentDir);
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
