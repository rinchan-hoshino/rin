import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

type StoreRoot = {
  storeDir: string;
  recordsDir: string;
  indexesDir: string;
  logDir: string;
};
const layout = await importBuiltModule<{
  sanitizePathSegment(value: string, fallback: string): string;
  recordsDirForStoreDir(storeDir: string): string;
  indexesDirForStoreDir(storeDir: string): string;
  getChatMessageStoreLayout(
    agentDir: string,
  ): StoreRoot & { primaryRoot: StoreRoot; readRoots: StoreRoot[] };
  chatMessageStoreRoots(agentDir: string): string[];
  recordRoots(agentDir: string): string[];
  indexRoots(agentDir: string): string[];
  chatScopedDatePath(
    root: string,
    chatKey: string,
    date: string,
    extension: ".json" | ".txt",
  ): string;
}>("dist/core/chat/message-store-layout.js");

async function withRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-message-layout-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("message store layout uses one preferred root and derived subdirectories", async () => {
  await withRoot(async (root) => {
    const result = layout.getChatMessageStoreLayout(root);
    const storeDir = path.join(root, "data", "chat", "message-store");
    assert.equal(result.storeDir, storeDir);
    assert.equal(result.primaryRoot.storeDir, storeDir);
    assert.deepEqual(
      result.readRoots.map((item) => item.storeDir),
      [storeDir],
    );
    assert.deepEqual(layout.chatMessageStoreRoots(root), [storeDir]);
    assert.deepEqual(layout.recordRoots(root), [
      path.join(storeDir, "records"),
    ]);
    assert.deepEqual(layout.indexRoots(root), [path.join(storeDir, "indexes")]);
    assert.equal(
      layout.recordsDirForStoreDir(storeDir),
      path.join(storeDir, "records"),
    );
    assert.equal(
      layout.indexesDirForStoreDir(storeDir),
      path.join(storeDir, "indexes"),
    );
  });
});

test("message store layout keeps the preferred root when a legacy root exists", async () => {
  await withRoot(async (root) => {
    await fs.mkdir(path.join(root, "data", "koishi-message-store"), {
      recursive: true,
    });
    const preferred = path.join(root, "data", "chat", "message-store");
    const result = layout.getChatMessageStoreLayout(root);
    assert.equal(result.storeDir, preferred);
    assert.deepEqual(
      result.readRoots.map((item) => item.storeDir),
      [preferred],
    );
    assert.deepEqual(layout.chatMessageStoreRoots(root), [preferred]);
  });
});

test("message store scoped paths validate chat keys and sanitize path segments", () => {
  assert.equal(layout.sanitizePathSegment(" a/b c ", "fallback"), "a_b_c");
  assert.equal(layout.sanitizePathSegment("", "fallback"), "fallback");
  assert.equal(
    layout.chatScopedDatePath(
      "/tmp/store",
      "discord/bot:room/name",
      "2026-07-16",
      ".json",
    ),
    path.join("/tmp/store", "discord", "bot", "room_name", "2026-07-16.json"),
  );
  assert.throws(
    () => layout.chatScopedDatePath("/tmp/store", "bad", "2026-07-16", ".txt"),
    /invalid_chatKey:bad/,
  );
});
