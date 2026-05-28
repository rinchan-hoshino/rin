import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  chatDataPath,
  coreDataPath,
  extensionDataPath,
  LEGACY_DATA_LAYOUT_MOVES,
  schedulerDataPath,
  sidecarDataPath,
} from "../../src/core/data-layout.js";

test("data layout helpers group runtime state by owner", () => {
  const root = path.join(os.tmpdir(), "rin-data-layout-root");
  assert.equal(
    chatDataPath(root, "inbox"),
    path.join(root, "data", "chat", "inbox"),
  );
  assert.equal(
    coreDataPath(root, "usage"),
    path.join(root, "data", "core", "usage"),
  );
  assert.equal(
    schedulerDataPath(root, "turns"),
    path.join(root, "data", "scheduler", "turns"),
  );
  assert.equal(
    sidecarDataPath(root, "web-search"),
    path.join(root, "data", "sidecars", "web-search"),
  );
  assert.equal(
    extensionDataPath(root, "runtime"),
    path.join(root, "data", "extensions", "runtime"),
  );
});

test("legacy data layout moves are installer-owned and keep migrations global", () => {
  const byFrom = new Map(
    LEGACY_DATA_LAYOUT_MOVES.map((move) => [move.from, move]),
  );
  assert.equal(byFrom.get("chat-inbox")?.to, path.join("chat", "inbox"));
  assert.equal(byFrom.get("cron")?.to, "scheduler");
  assert.equal(
    byFrom.get("extension-runtime")?.to,
    path.join("extensions", "runtime"),
  );
  assert.equal(byFrom.has("migrations"), false);
});
