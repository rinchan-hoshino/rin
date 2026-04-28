import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const chatDate = await import(
  new URL("../../dist/core/chat/date.js", import.meta.url).href
);

async function runInTimezone(source, timezone = "Asia/Shanghai") {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        ROOT_DIR: rootDir,
        TZ: timezone,
      },
    },
  );
  return JSON.parse(stdout.trim());
}

test("chat local-day storage stays aligned with explicit chat-log dates", async () => {
  const result = await runInTimezone(`
    import fs from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const rootDir = process.env.ROOT_DIR;
    const chatLog = await import(
      pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat-log.js")).href
    );
    const messageStore = await import(
      pathToFileURL(path.join(rootDir, "dist", "core", "chat", "message-store.js")).href
    );

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-chat-local-date-"));
    try {
      messageStore.saveChatMessage(root, {
        messageId: "m1",
        role: "user",
        chatKey: "telegram/123:456",
        platform: "telegram",
        botId: "123",
        chatId: "456",
        chatType: "private",
        receivedAt: "2026-04-05T00:30:00+08:00",
        text: "late night",
        rawContent: "late night",
        strippedContent: "late night",
      });

      const filePath = chatLog.chatLogPath(
        root,
        "telegram/123:456",
        "2026-04-05T00:30:00+08:00",
      );
      const storeViewPath = messageStore.chatMessageLogPath(
        root,
        "telegram/123:456",
        "2026-04-05T00:30:00+08:00",
      );
      const sameDay = messageStore
        .listChatMessagesByChatAndDate(root, "telegram/123:456", "2026-04-05")
        .map((item) => item.messageId);
      const previousDay = messageStore
        .listChatMessagesByChatAndDate(root, "telegram/123:456", "2026-04-04")
        .map((item) => item.messageId);

      console.log(JSON.stringify({ filePath, storeViewPath, sameDay, previousDay }));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  `);

  assert.equal(result.filePath, result.storeViewPath);
  assert.match(result.filePath, /2026-04-05\.txt$/);
  assert.deepEqual(result.sameDay, ["m1"]);
  assert.deepEqual(result.previousDay, []);
});

test("chat local date normalization accepts canonical dates and rejects invalid noise", () => {
  assert.equal(chatDate.normalizeLocalDateOnly("2026-04-20"), "2026-04-20");
  assert.equal(
    chatDate.normalizeLocalDateOnly("2026-04-20T00:30:00+08:00"),
    "2026-04-20",
  );
  assert.equal(
    chatDate.normalizeLocalDateOnly("2024-02-29T23:59:59Z"),
    "2024-02-29",
  );
  assert.equal(
    chatDate.normalizeLocalDateOnly(
      "2026-04-20 trailing-noise",
      new Date("2026-04-21T00:00:00Z"),
    ),
    "2026-04-21",
  );
  assert.equal(
    chatDate.normalizeLocalDateOnly(
      "2026-02-29",
      new Date("2026-03-01T00:00:00Z"),
    ),
    "2026-03-01",
  );
  assert.equal(chatDate.normalizeLocalDateOnly("2026-13-01"), "");
});
