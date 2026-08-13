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
      if (file === "missing") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return file;
    },
    (value, file) => (file === "valid" ? { value, file } : null),
  );
  assert.deepEqual(result, { value: "valid", file: "valid" });
  assert.deepEqual(reads, ["missing", "invalid", "valid"]);
});

test("candidate loader skips missing and malformed candidates but surfaces I/O failures", () => {
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
      ["malformed"],
      () => {
        throw new SyntaxError("malformed");
      },
      () => ({ value: true }),
    ),
    null,
  );
  assert.throws(
    () =>
      candidates.loadFirstValidCandidate(
        ["unreadable"],
        () => {
          throw Object.assign(new Error("unreadable"), { code: "EACCES" });
        },
        () => ({ value: true }),
      ),
    /unreadable/,
  );
  assert.throws(
    () =>
      candidates.loadFirstValidCandidate(
        ["one", "two"],
        (file) => file,
        (_value, file) => {
          if (file === "two") throw new Error("invalid");
          return null;
        },
      ),
    /invalid/,
  );
});
