import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  closeChatDatabase,
  writeChatSessionBinding,
} from "../../dist/core/chat/database.js";
import {
  ChatSessionConversationReader,
  createDaemonChatAPI,
  resolveChatSessionStates,
} from "../../dist/core/chat/session-state.js";

test("chat state follows only the current bound session", async () => {
  const states = await resolveChatSessionStates({
    chatKeys: ["discord/1:new", "discord/1:working", "discord/1:waiting"],
    readBinding: (chatKey) => `/sessions/${chatKey.split(":").at(-1)}.jsonl`,
    isSessionExecuting: (sessionFile) =>
      sessionFile === "/sessions/working.jsonl",
    readSessionHasConversation: async (sessionFile) =>
      sessionFile === "/sessions/waiting.jsonl",
  });

  assert.deepEqual(states, {
    "discord/1:new": "idle",
    "discord/1:working": "executing",
    "discord/1:waiting": "waiting",
  });
});

test("unbound chats are idle without reading unrelated sessions", async () => {
  const reads: string[] = [];
  const states = await resolveChatSessionStates({
    chatKeys: ["discord/1:empty", "discord/1:unbound"],
    readBinding: (chatKey) =>
      chatKey.endsWith(":unbound") ? undefined : "/sessions/empty.jsonl",
    isSessionExecuting: () => false,
    readSessionHasConversation: async (sessionFile) => {
      reads.push(sessionFile);
      return false;
    },
  });

  assert.deepEqual(states, {
    "discord/1:empty": "idle",
    "discord/1:unbound": "idle",
  });
  assert.deepEqual(reads, ["/sessions/empty.jsonl"]);
});

test("the daemon API lists chat keys and resolves only their bound sessions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-daemon-chat-api-"));
  const emptySession = path.join(root, "empty.jsonl");
  const waitingSession = path.join(root, "waiting.jsonl");
  try {
    const header = {
      type: "session",
      version: 3,
      id: "session",
      timestamp: "2026-08-10T00:00:00.000Z",
      cwd: root,
    };
    await fs.writeFile(emptySession, `${JSON.stringify(header)}\n`, "utf8");
    await fs.writeFile(
      waitingSession,
      `${JSON.stringify(header)}\n${JSON.stringify({ type: "message", id: "user", parentId: null, timestamp: "2026-08-10T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } })}\n`,
      "utf8",
    );
    writeChatSessionBinding(root, "discord/1:10", emptySession);
    writeChatSessionBinding(root, "discord/1:20", waitingSession);
    writeChatSessionBinding(root, "telegram/1:30", waitingSession);

    const api = createDaemonChatAPI({
      agentDir: root,
      getActivity: () => ({
        workers: [
          {
            sessionFile: emptySession,
            state: "working",
            turnActive: true,
          },
        ],
      }),
    });
    assert.deepEqual(await api.listKeys(), [
      "discord/1:10",
      "discord/1:20",
      "telegram/1:30",
    ]);
    assert.deepEqual(
      await api.listKeys({ platform: "discord", accountIds: ["1"] }),
      ["discord/1:10", "discord/1:20"],
    );
    assert.deepEqual(
      await api.getSessionStates(["discord/1:10", "discord/1:20"]),
      {
        "discord/1:10": "executing",
        "discord/1:20": "waiting",
      },
    );

    writeChatSessionBinding(
      root,
      "discord/1:20",
      path.join(root, "fresh.jsonl"),
    );
    assert.equal(
      (await api.getSessionStates(["discord/1:20"]))["discord/1:20"],
      "idle",
    );
  } finally {
    closeChatDatabase(root);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("conversation state comes from Pi's bound session context", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-session-state-"),
  );
  const sessionFile = path.join(root, "session.jsonl");
  const reader = new ChatSessionConversationReader();
  try {
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: "session", timestamp: "2026-08-10T00:00:00.000Z", cwd: root })}\n`,
      "utf8",
    );
    assert.equal(await reader.hasConversation(sessionFile), false);

    await fs.appendFile(
      sessionFile,
      `${JSON.stringify({ type: "message", id: "user", parentId: null, timestamp: "2026-08-10T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 } })}\n`,
      "utf8",
    );
    assert.equal(await reader.hasConversation(sessionFile), true);
    assert.equal(await reader.hasConversation(sessionFile), true);
    await assert.rejects(
      reader.hasConversation("\0"),
      /path.*null bytes|must be.*without null bytes/i,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
