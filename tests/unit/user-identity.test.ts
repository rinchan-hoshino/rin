import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const identity = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "user-identity.js")).href
);

test("shared user identity preserves platform comparison rules", () => {
  assert.equal(identity.normalizeUserName(" demo "), "demo");
  assert.equal(
    identity.isSameSystemUser("DESKTOP\\Demo", "desktop/demo", "win32"),
    true,
  );
  assert.equal(identity.isSameSystemUser("alice", "Alice", "linux"), false);
  assert.equal(identity.isSameSystemUser("", "", "linux"), false);
});
