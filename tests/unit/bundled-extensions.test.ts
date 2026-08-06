import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const bundled = await importBuiltModule<
  typeof import("../../src/core/rin-bundled-extensions.js")
>("dist/core/rin-bundled-extensions.js");

const removedPath = path.resolve("extensions/rin-browse");

test("bundled extension aliases reject every retired browse entry shape", () => {
  assert.deepEqual(bundled.BUILT_IN_RIN_EXTENSIONS, []);
  for (const entry of [
    "rin:browse",
    "!rin:browse",
    "+rin:browse",
    "-rin:browse",
    removedPath,
    path.join(removedPath, "index.ts"),
    path.join(removedPath, "index.js"),
  ]) {
    assert.equal(bundled.isRemovedBuiltInRinExtensionEntry(entry), true, entry);
    assert.equal(bundled.expandBundledRinExtensionEntry(entry), "", entry);
  }
  for (const entry of ["rin:browser-use", "rin:computer-use", "custom-ext"]) {
    assert.equal(bundled.resolveBundledRinExtensionPath(entry), "");
    assert.equal(bundled.expandBundledRinExtensionEntry(entry), entry);
  }
  assert.equal(bundled.expandBundledRinExtensionEntry("   "), "");
});

test("bundled extension entry lists strip retired values without mutating other aliases", () => {
  assert.deepEqual(bundled.stripRemovedBuiltInRinExtensionEntries(null), []);
  assert.deepEqual(
    bundled.stripRemovedBuiltInRinExtensionEntries([
      " rin:browse ",
      " !rin:browse ",
      " custom-ext ",
      42,
      " ",
    ]),
    ["custom-ext", "42"],
  );
  assert.deepEqual(bundled.expandBundledRinExtensionEntries(undefined), []);
  assert.deepEqual(
    bundled.expandBundledRinExtensionEntries([
      "rin:browse",
      "!rin:browse",
      "custom-ext",
      "+custom-ext",
    ]),
    ["custom-ext", "+custom-ext"],
  );
});

test("bundled extension enablement uses last matching alias and canonical writes", () => {
  assert.equal(bundled.isBuiltInRinExtensionEnabled(null, "custom-ext"), false);
  assert.equal(
    bundled.isBuiltInRinExtensionEnabled(
      ["custom-ext", "!custom-ext", "+custom-ext"],
      "custom-ext",
    ),
    true,
  );
  assert.equal(
    bundled.isBuiltInRinExtensionEnabled(
      ["custom-ext", "-custom-ext"],
      "custom-ext",
    ),
    false,
  );
  assert.deepEqual(
    bundled.setBuiltInRinExtensionEnabled(
      ["rin:browse", "!custom-ext", "other"],
      "custom-ext",
      true,
    ),
    ["other", "custom-ext"],
  );
  assert.deepEqual(
    bundled.setBuiltInRinExtensionEnabled(
      ["custom-ext", "other"],
      "custom-ext",
      false,
    ),
    ["other"],
  );
});

test("bundled extension settings aliases are applied once and refreshed after reload", async () => {
  const overrides: unknown[] = [];
  let reloads = 0;
  const manager: any = {
    getExtensionPaths: () => ["rin:browse", "custom-ext"],
    getGlobalSettings: () => ({ extensions: ["rin:browse", "global-ext"] }),
    getProjectSettings: () => ({ extensions: "unchanged" }),
    applyOverrides: (value: unknown) => overrides.push(value),
    reload: async () => {
      reloads += 1;
    },
  };

  bundled.applyBundledRinExtensionAliases(manager);
  assert.deepEqual(manager.getGlobalSettings(), { extensions: ["global-ext"] });
  assert.deepEqual(manager.getProjectSettings(), { extensions: "unchanged" });
  assert.deepEqual(overrides, [{ extensions: ["custom-ext"] }]);

  await manager.reload();
  assert.equal(reloads, 1);
  assert.deepEqual(overrides, [
    { extensions: ["custom-ext"] },
    { extensions: ["custom-ext"] },
  ]);

  bundled.applyBundledRinExtensionAliases(manager);
  assert.equal(manager.__rinBundledExtensionAliasesApplied, true);
  assert.deepEqual(overrides, [
    { extensions: ["custom-ext"] },
    { extensions: ["custom-ext"] },
  ]);
});

test("bundled extension alias application tolerates partial and unchanged managers", () => {
  bundled.applyBundledRinExtensionAliases(null);
  bundled.applyBundledRinExtensionAliases({});

  let applied = 0;
  const manager: any = {
    getExtensionPaths: () => ["custom-ext"],
    getGlobalSettings: () => null,
    getProjectSettings: () => ({ extensions: ["custom-ext"] }),
    applyOverrides: () => {
      applied += 1;
    },
  };
  bundled.applyBundledRinExtensionAliases(manager);

  assert.equal(applied, 0);
  assert.equal(manager.getGlobalSettings(), null);
  assert.deepEqual(manager.getProjectSettings(), {
    extensions: ["custom-ext"],
  });
});
