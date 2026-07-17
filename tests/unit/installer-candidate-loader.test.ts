import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const candidates = await importBuiltModule<{
  loadFirstValidCandidate<T>(
    paths: string[],
    read: (path: string) => unknown,
    normalize: (value: unknown, path: string) => T | null,
  ): T | null;
}>("dist/core/rin-install/candidate-loader.js");

test("candidate loader returns the first normalized candidate and stops reading", () => {
  const reads: string[] = [];
  const result = candidates.loadFirstValidCandidate(
    ["missing", "invalid", "valid", "unused"],
    (file) => {
      reads.push(file);
      if (file === "missing") throw new Error("missing");
      return file;
    },
    (value, file) => (file === "valid" ? { value, file } : null),
  );
  assert.deepEqual(result, { value: "valid", file: "valid" });
  assert.deepEqual(reads, ["missing", "invalid", "valid"]);
});

test("candidate loader returns null for empty, rejected, and throwing candidates", () => {
  assert.equal(
    candidates.loadFirstValidCandidate(
      [],
      () => 1,
      () => 1,
    ),
    null,
  );
  assert.equal(
    candidates.loadFirstValidCandidate(
      ["one", "two"],
      (file) => file,
      (_value, file) => {
        if (file === "two") throw new Error("invalid");
        return null;
      },
    ),
    null,
  );
});
