import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const runtimeMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href
);

async function withTempRoot(fn: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-compaction-continuation-test-"),
  );
  try {
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withConfiguredTempRoot(dir: string, fn: () => Promise<void>) {
  const previousTmpDir = process.env.TMPDIR;
  try {
    process.env.TMPDIR = dir;
    await fn();
  } finally {
    if (previousTmpDir == null) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpDir;
  }
}

function createSession(id: string) {
  return {
    sessionManager: {
      getSessionId() {
        return id;
      },
    },
  };
}

test("compaction continuation markers prefer the configured temp root", async () => {
  await withTempRoot(async (dir) => {
    await withConfiguredTempRoot(dir, async () => {
      const session = createSession("session-temp-root");
      const markerPath =
        runtimeMod.getCompactionContinuationMarkerPath(session);

      assert.ok(
        markerPath.startsWith(
          path.join(path.resolve(dir), "rin-compaction-continuation") +
            path.sep,
        ),
      );

      runtimeMod.writeCompactionContinuationMarker(session, {
        reason: "threshold",
        assistantPreview: "continue",
      });
      const stored = JSON.parse(await fs.readFile(markerPath, "utf8"));
      assert.equal(stored.reason, "threshold");
    });
  });
});

test("compaction continuation markers roundtrip once and clear invalid marker files", async () => {
  await withTempRoot(async (dir) => {
    await withConfiguredTempRoot(dir, async () => {
      const session = createSession("session-roundtrip");
      const markerPath =
        runtimeMod.getCompactionContinuationMarkerPath(session);

      runtimeMod.writeCompactionContinuationMarker(session, {
        reason: "overflow",
        assistantPreview: "next step",
      });
      assert.equal(
        runtimeMod.consumeCompactionContinuationMarker(session)?.reason,
        "overflow",
      );
      assert.equal(
        runtimeMod.consumeCompactionContinuationMarker(session),
        undefined,
      );

      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(
        markerPath,
        JSON.stringify({ version: 1, reason: "invalid", at: Date.now() }),
        "utf8",
      );

      assert.equal(
        runtimeMod.consumeCompactionContinuationMarker(session),
        undefined,
      );
      await assert.rejects(fs.access(markerPath));
    });
  });
});

test("compaction continuation markers fall back when the preferred temp root is unusable", async () => {
  await withTempRoot(async (tempRoot) => {
    const blocker = path.join(tempRoot, "blocked-root");
    await fs.writeFile(blocker, "not a directory", "utf8");

    await withConfiguredTempRoot(path.join(blocker, "nested"), async () => {
      const session = createSession(`session-fallback-${process.pid}`);
      runtimeMod.clearCompactionContinuationMarker(session);

      runtimeMod.writeCompactionContinuationMarker(session, {
        reason: "overflow",
        assistantPreview: "continue after overflow",
      });

      const marker = runtimeMod.consumeCompactionContinuationMarker(session);
      assert.equal(marker?.reason, "overflow");
      assert.equal(marker?.assistantPreview, "continue after overflow");
      assert.equal(
        runtimeMod.consumeCompactionContinuationMarker(session),
        undefined,
      );
    });
  });
});
