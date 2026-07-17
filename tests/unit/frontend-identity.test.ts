import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const frontendIdentityMod = await import(
  pathToFileURL(
    path.join(
      rootDir,
      "dist",
      "core",
      "rin-frontend-sdk",
      "frontend-identity.js",
    ),
  ).href
);

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
    frontendIdentityMod.sameFrontendIdentity({ kind: "gui" }, { kind: "gui" }),
    true,
  );
  assert.equal(
    frontendIdentityMod.sameFrontendIdentity(
      { kind: "gui", key: "desktop/main" },
      { kind: "gui", key: "desktop/main" },
    ),
    true,
  );
});
