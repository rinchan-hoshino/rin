import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const utils = await importBuiltModule<
  Record<string, (...args: unknown[]) => unknown>
>("dist/core/self-improve/core/utils.js");

test("self-improve list and slug normalization remove noise deterministically", () => {
  assert.deepEqual(utils.normalizeList([" one ", "", "one", 2]), ["one", "2"]);
  assert.deepEqual(utils.normalizeList("one, two,one"), ["one", "two"]);
  assert.equal(
    utils.slugify(" Hello\uFF0C\u4E16\u754C "),
    "hello-\u4E16\u754C",
  );
  assert.equal(utils.slugify("---", "fallback"), "fallback");
  assert.equal((utils.slugify("a".repeat(100)) as string).length, 80);
});

test("self-improve concept tokens combine unique Latin tokens and CJK bigrams", () => {
  assert.deepEqual(utils.cjkBigrams(" \u4E2D\u6587 \u4E2D\u6587 A "), [
    "\u4E2D\u6587",
    "\u6587\u4E2D",
  ]);
  assert.deepEqual(utils.cjkBigrams("a b"), []);
  assert.deepEqual(utils.conceptTokens("Hello hello \u4E2D\u6587"), [
    "hello",
    "\u4E2D\u6587",
  ]);
});
