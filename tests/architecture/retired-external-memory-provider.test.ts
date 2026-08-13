import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function source(relativePath: string) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

test("Rin memory has no retired external provider surface", () => {
  assert.equal(
    fs.existsSync(path.join(rootDir, "src/core/memory/external.ts")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(rootDir, "src/core/memory/external-results.ts")),
    false,
  );

  for (const relativePath of [
    "src/core/memory/index.ts",
    "src/core/rin-extension-api.ts",
    "src/core/rin-daemon/extensions.ts",
    "src/core/rin-daemon/daemon.ts",
    "src/core/rin-lib/rpc-types.ts",
  ]) {
    const text = source(relativePath);
    assert.doesNotMatch(
      text,
      /registerMemoryProvider|memory_(?:search|write)_external|searchExternalMemoryProviders|writeExternalMemoryEntry/,
    );
  }
});
