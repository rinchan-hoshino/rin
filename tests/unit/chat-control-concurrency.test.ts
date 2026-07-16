import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const inbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "inbox.js")).href
);
const outbox = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "chat-outbox.js"))
    .href
);

async function runClaim(agentDir, modulePath, expression) {
  const code = `
    const mod = await import(process.env.MODULE_URL);
    const result = ${expression};
    console.log(JSON.stringify({ claimed: Boolean(result), ownerEpoch: result?.ownerEpoch }));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", code],
    {
      env: {
        ...process.env,
        AGENT_DIR: agentDir,
        MODULE_URL: pathToFileURL(path.join(rootDir, "dist", ...modulePath))
          .href,
      },
      timeout: 30_000,
    },
  );
  return JSON.parse(stdout.trim());
}

test("cross-process inbox and outbox claims each elect one fenced owner", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-claim-race-"),
  );
  try {
    const turn = inbox.enqueueChatInboxItem(agentDir, {
      chatKey: "telegram/1:race",
      messageId: "inbound-race",
      session: {
        platform: "telegram",
        selfId: "1",
        channelId: "race",
        userId: "owner",
        messageId: "inbound-race",
        timestamp: Date.now(),
        content: "race",
        stripped: { content: "race" },
      },
      elements: [{ type: "text", attrs: { content: "race" } }],
    }).item;
    const outboxId = outbox.enqueueChatOutboxPayload(agentDir, {
      chatKey: "telegram/1:race",
      parts: [{ type: "text", text: "race" }],
    });

    const inboxResults = await Promise.all(
      Array.from({ length: 8 }, () =>
        runClaim(
          agentDir,
          ["core", "chat", "inbox.js"],
          `mod.claimChatInboxItem(process.env.AGENT_DIR, ${JSON.stringify(turn.itemId)})`,
        ),
      ),
    );
    const outboxResults = await Promise.all(
      Array.from({ length: 8 }, () =>
        runClaim(
          agentDir,
          ["core", "rin-lib", "chat-outbox.js"],
          `mod.claimChatOutboxItem(process.env.AGENT_DIR, ${JSON.stringify(outboxId)}, { leaseUntil: new Date(Date.now() + 60000).toISOString() })`,
        ),
      ),
    );

    assert.equal(inboxResults.filter((item) => item.claimed).length, 1);
    assert.equal(outboxResults.filter((item) => item.claimed).length, 1);
    assert.ok(inboxResults.find((item) => item.claimed)?.ownerEpoch);
    assert.ok(outboxResults.find((item) => item.claimed)?.ownerEpoch);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
