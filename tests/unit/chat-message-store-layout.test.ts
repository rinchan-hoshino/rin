import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const layoutModule = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "message-store-layout.js"),
  ).href
);

const {
  chatMessageStoreRoots,
  getChatMessageStoreLayout,
  indexRoots,
  recordRoots,
} = layoutModule;

async function withTempRoot(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-message-store-layout-"),
  );
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("message store layout defaults to the preferred root", async () => {
  await withTempRoot(async (root) => {
    const layout = getChatMessageStoreLayout(root);
    const preferredStoreDir = path.join(root, "data", "chat", "message-store");
    const legacyStoreDirs = [
      path.join(root, "data", "koishi-message-store"),
      path.join(root, "data", "chat-message-store"),
    ];

    assert.equal(layout.storeDir, preferredStoreDir);
    assert.equal(layout.primaryRoot.storeDir, preferredStoreDir);
    assert.deepEqual(
      layout.readRoots.map((item: { storeDir: string }) => item.storeDir),
      [preferredStoreDir, ...legacyStoreDirs],
    );
    assert.deepEqual(chatMessageStoreRoots(root), [
      preferredStoreDir,
      ...legacyStoreDirs,
    ]);
    assert.deepEqual(
      recordRoots(root),
      [preferredStoreDir, ...legacyStoreDirs].map((dir) =>
        path.join(dir, "records"),
      ),
    );
    assert.deepEqual(
      indexRoots(root),
      [preferredStoreDir, ...legacyStoreDirs].map((dir) =>
        path.join(dir, "indexes"),
      ),
    );
  });
});

test("message store layout keeps using the preferred root when a previous root exists", async () => {
  await withTempRoot(async (root) => {
    const preferredStoreDir = path.join(root, "data", "chat", "message-store");
    await fs.mkdir(path.join(root, "data", "koishi-message-store"), {
      recursive: true,
    });

    const layout = getChatMessageStoreLayout(root);

    assert.equal(layout.storeDir, preferredStoreDir);
    assert.equal(layout.primaryRoot.storeDir, preferredStoreDir);
    const expectedRoots = [
      preferredStoreDir,
      path.join(root, "data", "koishi-message-store"),
      path.join(root, "data", "chat-message-store"),
    ];
    assert.deepEqual(
      layout.readRoots.map((item: { storeDir: string }) => item.storeDir),
      expectedRoots,
    );
    assert.deepEqual(chatMessageStoreRoots(root), expectedRoots);
  });
});
