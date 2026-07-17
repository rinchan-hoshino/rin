import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const memory = await importBuiltModule<
  Record<string, (...args: unknown[]) => unknown>
>("dist/core/memory/utils.js");

test("memory utils hash text with stable SHA-256", () => {
  assert.equal(
    memory.sha("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("memory timestamps accept milliseconds, seconds, small numbers, and dates", () => {
  assert.equal(memory.parseTimestampMs(undefined), 0);
  assert.equal(memory.parseTimestampMs(" "), 0);
  assert.equal(memory.parseTimestampMs("1700000000000.9"), 1700000000000);
  assert.equal(memory.parseTimestampMs("-1700000000"), -1700000000000);
  assert.equal(memory.parseTimestampMs("42.9"), 42);
  assert.equal(
    memory.parseTimestampMs("2026-07-16T00:00:00.000Z"),
    Date.UTC(2026, 6, 16),
  );
  assert.equal(memory.parseTimestampMs("not-a-date"), 0);
});
