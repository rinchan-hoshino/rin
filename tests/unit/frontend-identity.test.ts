import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const frontendIdentityMod = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "frontend-identity.js"),
  ).href
);

test("frontend identity normalization requires a kind and accepts legacy id keys", () => {
  assert.equal(
    frontendIdentityMod.normalizeFrontendIdentity(undefined),
    undefined,
  );
  assert.equal(
    frontendIdentityMod.normalizeFrontendIdentity({ kind: " " }),
    undefined,
  );
  assert.deepEqual(
    frontendIdentityMod.normalizeFrontendIdentity({ kind: " tui " }),
    { kind: "tui" },
  );
  assert.deepEqual(
    frontendIdentityMod.normalizeFrontendIdentity({
      kind: "chat",
      key: " room ",
    }),
    { kind: "chat", key: "room" },
  );
  assert.deepEqual(
    frontendIdentityMod.normalizeFrontendIdentity({ kind: "chat", id: 42 }),
    { kind: "chat", key: "42" },
  );
});

test("frontend identity factories normalize source and chat keys", () => {
  assert.deepEqual(frontendIdentityMod.chatFrontendIdentity(" room "), {
    kind: "chat",
    key: "room",
  });
  assert.equal(frontendIdentityMod.chatFrontendIdentity(" "), undefined);
  assert.deepEqual(frontendIdentityMod.sourceFrontendIdentity(" "), {
    kind: "frontend",
  });
  assert.deepEqual(frontendIdentityMod.sourceFrontendIdentity(" api "), {
    kind: "api",
  });
  assert.equal(
    frontendIdentityMod.sameFrontendIdentity(
      { kind: "chat", key: " room " },
      { kind: "chat", id: "room" },
    ),
    true,
  );
  assert.equal(
    frontendIdentityMod.sameFrontendIdentity(
      { kind: "chat", key: "a" },
      { kind: "chat", key: "b" },
    ),
    false,
  );
  assert.equal(
    frontendIdentityMod.sameFrontendIdentity(undefined, { kind: "chat" }),
    false,
  );
});

test("TUI frontend identities preserve per-instance keys", () => {
  assert.deepEqual(
    frontendIdentityMod.normalizeFrontendIdentity({
      kind: "tui",
      key: " terminal/main ",
    }),
    { kind: "tui", key: "terminal/main" },
  );
  assert.deepEqual(
    frontendIdentityMod.normalizeFrontendIdentity({
      kind: "tui",
      id: "terminal/main",
    }),
    { kind: "tui", key: "terminal/main" },
  );
});

test("each TUI instance gets a distinct stable frontend identity", () => {
  const first = frontendIdentityMod.createTuiFrontendIdentity();
  const second = frontendIdentityMod.createTuiFrontendIdentity();
  assert.equal(first.kind, "tui");
  assert.ok(first.key);
  assert.notDeepEqual(first, second);
  assert.equal(frontendIdentityMod.sameFrontendIdentity(first, first), true);
  assert.equal(frontendIdentityMod.sameFrontendIdentity(first, second), false);
  assert.equal(
    frontendIdentityMod.sameFrontendIdentity({ kind: "tui" }, { kind: "tui" }),
    false,
  );
});
