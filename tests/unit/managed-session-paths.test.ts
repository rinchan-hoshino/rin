import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const managedPaths = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "session", "managed-paths.js"),
  ).href
);

test("managed session paths normalize leaves into dedicated directories", () => {
  const agentDir = path.join("tmp", "rin-agent");

  assert.equal(
    managedPaths.normalizeManagedSessionLeaf(" ../chat room!! "),
    "chat_room",
  );
  assert.equal(managedPaths.normalizeManagedSessionLeaf(""), "session");
  assert.equal(
    managedPaths.getManagedSessionDir(agentDir, " ../chat room!! "),
    path.join(agentDir, "sessions", "managed", "chat_room"),
  );
  assert.equal(
    managedPaths.getManagedChatSessionDir(agentDir),
    path.join(agentDir, "sessions", "managed", "chat"),
  );
  assert.equal(
    managedPaths.getManagedTaskSessionDir(agentDir),
    path.join(agentDir, "sessions", "managed", "task"),
  );
  assert.equal(
    managedPaths.getManagedSubagentSessionDir(agentDir),
    path.join(agentDir, "sessions", "managed", "subagent"),
  );
});

test("managed session files stay under normalized leaves with unique jsonl names", () => {
  const agentDir = path.join("tmp", "rin-agent");
  const file = managedPaths.getManagedSessionFile(
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
