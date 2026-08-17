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

test("TUI frontend identities never retain address keys", () => {
  assert.deepEqual(
    frontendIdentityMod.normalizeFrontendIdentity({
      kind: "tui",
      key: "terminal/main",
    }),
    { kind: "tui" },
  );
  assert.deepEqual(
    frontendIdentityMod.normalizeFrontendIdentity({
      kind: "tui",
      id: "terminal/main",
    }),
    { kind: "tui" },
  );
});

test("normalized TUI identities cannot contaminate the shared identity", () => {
  const normalized = frontendIdentityMod.normalizeFrontendIdentity({
    kind: "tui",
  });
  assert.notEqual(normalized, frontendIdentityMod.TUI_FRONTEND_IDENTITY);
  normalized.key = "terminal/main";
  assert.deepEqual(
    frontendIdentityMod.normalizeFrontendIdentity({ kind: "tui" }),
    { kind: "tui" },
  );
  assert.deepEqual(frontendIdentityMod.TUI_FRONTEND_IDENTITY, { kind: "tui" });
  assert.equal(
    Object.isFrozen(frontendIdentityMod.TUI_FRONTEND_IDENTITY),
    true,
  );
});

test("TUI identities cannot bind while other frontend matching stays unchanged", () => {
  assert.equal(
    frontendIdentityMod.sameFrontendIdentity({ kind: "tui" }, { kind: "tui" }),
    false,
  );
  assert.equal(
    frontendIdentityMod.sameFrontendIdentity({ kind: "sdk" }, { kind: "sdk" }),
    true,
  );
  assert.equal(
    frontendIdentityMod.sameFrontendIdentity(
      { kind: "sdk", key: "client/main" },
      { kind: "sdk", key: "client/main" },
    ),
    true,
  );
});
