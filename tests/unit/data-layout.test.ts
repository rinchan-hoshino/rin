import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

type LegacyMove = { from: string; to: string };
const layout = await importBuiltModule<{
  LEGACY_DATA_LAYOUT_MOVES: LegacyMove[];
  coreDataPath(root: string, ...parts: string[]): string;
  chatDataPath(root: string, ...parts: string[]): string;
  schedulerDataPath(root: string, ...parts: string[]): string;
  sidecarDataPath(root: string, ...parts: string[]): string;
  extensionDataPath(root: string, ...parts: string[]): string;
  sharedRuntimeDataPath(root: string, ...parts: string[]): string;
}>("dist/core/data-layout.js");

test("data layout groups runtime state by its owning subsystem", () => {
  const root = path.resolve(path.sep, "tmp", "rin-data");
  assert.equal(
    layout.coreDataPath(root, "state"),
    path.join(root, "data", "core", "state"),
  );
  assert.equal(
    layout.chatDataPath(root, "inbox"),
    path.join(root, "data", "chat", "inbox"),
  );
  assert.equal(
    layout.schedulerDataPath(root, "turns"),
    path.join(root, "data", "scheduler", "turns"),
  );
  assert.equal(
    layout.sidecarDataPath(root, "browse"),
    path.join(root, "data", "sidecars", "browse"),
  );
  assert.equal(
    layout.extensionDataPath(root, "runtime"),
    path.join(root, "data", "extensions", "runtime"),
  );
  assert.equal(
    layout.sharedRuntimeDataPath(root, "locks"),
    path.join(root, "data", "runtime", "locks"),
  );
});

test("legacy data moves keep migrations global and owners explicit", () => {
  const byFrom = new Map(
    layout.LEGACY_DATA_LAYOUT_MOVES.map((move) => [move.from, move]),
  );
  assert.equal(byFrom.get("chat-inbox")?.to, path.join("chat", "inbox"));
  assert.equal(byFrom.get("cron")?.to, "scheduler");
  assert.equal(
    byFrom.get("extension-runtime")?.to,
    path.join("extensions", "runtime"),
  );
  assert.equal(byFrom.has("migrations"), false);
});
