import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const managed = await importBuiltModule<{
  normalizeManagedSessionLeaf(value: unknown): string;
  getManagedSessionRoot(agentDir: string): string;
  getManagedSessionDir(agentDir: string, leaf: unknown): string;
  getManagedChatSessionDir(agentDir: string): string;
  getManagedTaskSessionDir(agentDir: string): string;
  getManagedTaskSessionFile(agentDir: string, taskId: unknown): string;
  getManagedSessionSearchDirs(agentDir: string): string[];
  getManagedSessionFile(
    agentDir: string,
    leaf: unknown,
    name?: unknown,
  ): string;
}>("dist/core/session/managed-paths.js");

test("managed session paths sanitize leaves and stay under dedicated owners", () => {
  const agentDir = path.join("tmp", "rin-agent");
  assert.equal(
    managed.normalizeManagedSessionLeaf(" ../chat room!! "),
    "chat_room",
  );
  assert.equal(managed.normalizeManagedSessionLeaf(""), "session");
  assert.equal(
    managed.getManagedSessionRoot(agentDir),
    path.join(agentDir, "sessions", "managed"),
  );
  assert.equal(
    managed.getManagedChatSessionDir(agentDir),
    path.join(agentDir, "sessions", "managed", "chat"),
  );
  assert.equal(
    managed.getManagedTaskSessionDir(agentDir),
    path.join(agentDir, "sessions", "managed", "task"),
  );
  assert.deepEqual(managed.getManagedSessionSearchDirs(agentDir), [
    path.join(agentDir, "sessions"),
    path.join(agentDir, "sessions", "managed", "chat"),
    path.join(agentDir, "sessions", "managed", "task"),
    path.join(agentDir, "sessions", "managed", "cli"),
  ]);
});

test("managed task and unique session files use safe JSONL basenames", () => {
  const agentDir = path.join("tmp", "rin-agent");
  assert.equal(
    managed.getManagedTaskSessionFile(agentDir, "task:daily/demo"),
    path.join(agentDir, "sessions", "managed", "task", "task_daily_demo.jsonl"),
  );
  assert.equal(
    managed.getManagedTaskSessionFile(agentDir, " ... "),
    path.join(agentDir, "sessions", "managed", "task", "task.jsonl"),
  );
  const file = managed.getManagedSessionFile(
    agentDir,
    " ../chat room!! ",
    "room:one/demo",
  );
  assert.equal(
    path.dirname(file),
    path.join(agentDir, "sessions", "managed", "chat_room"),
  );
  assert.match(
    path.basename(file),
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_room_one_demo_[0-9a-f]{8}\.jsonl$/,
  );
});
