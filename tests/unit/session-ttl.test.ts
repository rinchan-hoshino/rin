import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const ttl = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "session", "ttl.js")).href
);

async function withTempAgent(fn: (agentDir: string) => Promise<void>) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-session-ttl-"));
  try {
    await fn(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

async function touch(filePath: string, mtimeMs: number) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "{}\n", "utf8");
  const date = new Date(mtimeMs);
  await fs.utimes(filePath, date, date);
}

test("session TTL maintenance deletes old session files in all session subdirectories", async () => {
  await withTempAgent(async (agentDir) => {
    const nowMs = Date.parse("2026-05-14T00:00:00.000Z");
    const oldMs = nowMs - 91 * 24 * 60 * 60 * 1000;
    const freshMs = nowMs - 10 * 24 * 60 * 60 * 1000;
    const oldRoot = path.join(agentDir, "sessions", "old-root.jsonl");
    const oldManaged = path.join(
      agentDir,
      "sessions",
      "managed",
      "chat",
      "old-chat.jsonl",
    );
    const freshManaged = path.join(
      agentDir,
      "sessions",
      "managed",
      "chat",
      "fresh-chat.jsonl",
    );

    await touch(oldRoot, oldMs);
    await touch(oldManaged, oldMs);
    await touch(freshManaged, freshMs);

    const result = await ttl.runSessionTtlMaintenance(agentDir, { nowMs });

    assert.equal(result.checked, 3);
    assert.deepEqual(
      result.deleted.map((item: string) => path.basename(item)).sort(),
      ["old-chat.jsonl", "old-root.jsonl"],
    );
    assert.equal(fsSync.existsSync(oldRoot), false);
    assert.equal(fsSync.existsSync(oldManaged), false);
    assert.equal(fsSync.existsSync(freshManaged), true);
  });
});

test("session TTL maintenance respects settings session.ttlEnabled false", async () => {
  await withTempAgent(async (agentDir) => {
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ session: { ttlEnabled: false } }),
      "utf8",
    );
    const nowMs = Date.parse("2026-05-14T00:00:00.000Z");
    const oldSession = path.join(agentDir, "sessions", "old.jsonl");
    await touch(oldSession, nowMs - 365 * 24 * 60 * 60 * 1000);

    const result = await ttl.runSessionTtlMaintenance(agentDir, { nowMs });

    assert.equal(result.enabled, false);
    assert.equal(result.deleted.length, 0);
    assert.equal(fsSync.existsSync(oldSession), true);
  });
});
