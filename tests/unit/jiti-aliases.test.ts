import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { importBuiltModule } from "../support/import-built-module.js";

const { resolveRuntimePackageAliases } = await importBuiltModule<
  typeof import("../../src/core/rin-lib/jiti-aliases.js")
>("dist/core/rin-lib/jiti-aliases.js");

test("runtime aliases resolve declared runtime dependencies without dev-only packages", () => {
  const aliases = resolveRuntimePackageAliases();
  assert.equal(typeof aliases["@earendil-works/pi-coding-agent"], "string");
  assert.equal(Object.hasOwn(aliases, "typescript"), false);
});

test("runtime aliases include declared development and optional dependencies only when requested", () => {
  const aliases = resolveRuntimePackageAliases({
    includeDevDependencies: true,
    includeOptionalDependencies: true,
  });
  assert.equal(typeof aliases.typescript, "string");
});

test("runtime aliases tolerate malformed manifests, non-file URLs, and missing packages", () => {
  const originalReadFileSync = fs.readFileSync;
  try {
    fs.readFileSync = ((filePath: fs.PathOrFileDescriptor, ...args: any[]) => {
      if (String(filePath).endsWith("package.json")) {
        return JSON.stringify({
          dependencies: {
            "node:path": "*",
            "missing-owner-package": "*",
          },
        });
      }
      return (originalReadFileSync as any)(filePath, ...args);
    }) as typeof fs.readFileSync;
    const aliases = resolveRuntimePackageAliases();
    assert.equal(aliases["node:path"], "node:path");
    assert.equal(Object.hasOwn(aliases, "missing-owner-package"), false);

    fs.readFileSync = (() => {
      throw new Error("owner malformed manifest");
    }) as typeof fs.readFileSync;
    assert.deepEqual(resolveRuntimePackageAliases(), {});
  } finally {
    fs.readFileSync = originalReadFileSync;
  }
});
