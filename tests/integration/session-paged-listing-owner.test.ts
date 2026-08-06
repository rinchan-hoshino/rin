import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const paged = await importBuiltModule<
  typeof import("../../src/core/session/paged-listing.js")
>("dist/core/session/paged-listing.js");

async function writeSession(
  dir: string,
  id: string,
  cwd: string,
  timestamp: string,
) {
  const filePath = path.join(dir, `${id}.jsonl`);
  await fs.writeFile(
    filePath,
    [
      { type: "session", version: 3, id, timestamp, cwd },
      {
        type: "message",
        id: `${id}-user`,
        timestamp,
        message: { role: "user", content: `question ${id}` },
      },
      {
        type: "message",
        id: `${id}-assistant`,
        timestamp,
        message: { role: "assistant", content: `answer ${id}` },
      },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  return filePath;
}

test("session page normalization applies finite defaults and caps", () => {
  assert.equal(paged.normalizeSessionPageLimit(undefined), 30);
  assert.equal(paged.normalizeSessionPageLimit("0"), 30);
  assert.equal(paged.normalizeSessionPageLimit("12 items"), 12);
  assert.equal(paged.normalizeSessionPageLimit(9999), 500);
  assert.equal(paged.normalizeSessionPageOffset(undefined), 0);
  assert.equal(paged.normalizeSessionPageOffset(-2), 0);
  assert.equal(paged.normalizeSessionPageOffset("7 records"), 7);
});

test("session paging reads newest matching records from its catalog", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-page-owner-"));
  const cwd = path.join(dir, "project");
  try {
    await writeSession(dir, "old", cwd, "2026-07-14T00:00:00.000Z");
    await writeSession(dir, "new", cwd, "2026-07-16T00:00:00.000Z");
    await writeSession(
      dir,
      "other",
      path.join(dir, "other"),
      "2026-07-17T00:00:00.000Z",
    );

    const first = await paged.listBoundSessionPage({
      sessionDir: dir,
      cwd,
      limit: 1,
    });
    assert.deepEqual(
      first.sessions.map((session) => session.id),
      ["new"],
    );
    assert.equal(first.offset, 0);
    assert.equal(first.limit, 1);
    assert.equal(first.total, 2);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 1);

    const second = await paged.listBoundSessionPage({
      sessionDir: dir,
      cwd,
      limit: 1,
      offset: first.nextOffset,
    });
    assert.deepEqual(
      second.sessions.map((session) => session.id),
      ["old"],
    );
    assert.equal(second.hasMore, false);
    assert.equal(second.nextOffset, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("session paging falls back to record files if catalog state disappears", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-page-race-"));
  const cwd = path.join(dir, "project");
  try {
    await writeSession(dir, "first", cwd, "2026-07-14T00:00:00.000Z");
    await writeSession(dir, "second", cwd, "2026-07-15T00:00:00.000Z");
    await paged.listBoundSessionPage({ sessionDir: dir, cwd, limit: 1 });

    const statePathSuffix = path.join(
      ".rin-session-catalog",
      "v1",
      "state.json",
    );
    const originalReadFile = fs.readFile.bind(fs);
    let stateReads = 0;
    const readFile = mock.method(fs, "readFile", (async (...args: any[]) => {
      if (String(args[0]).endsWith(statePathSuffix)) {
        stateReads += 1;
        if (stateReads === 2) {
          const error: NodeJS.ErrnoException = new Error("catalog raced away");
          error.code = "ENOENT";
          throw error;
        }
      }
      return await (originalReadFile as any)(...args);
    }) as typeof fs.readFile);
    try {
      const page = await paged.listBoundSessionPage({
        sessionDir: dir,
        cwd,
        limit: 1,
        offset: 1,
      });
      assert.deepEqual(
        page.sessions.map((session) => session.id),
        ["first"],
      );
      assert.equal(page.total, 2);
      assert.equal(page.hasMore, false);
    } finally {
      readFile.mock.restore();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
