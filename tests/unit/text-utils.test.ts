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
const textUtils = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "text-utils.js")).href
);

test("text utils normalize strings consistently", () => {
  assert.equal(textUtils.safeString(null), "");
  assert.equal(textUtils.safeString(42), "42");
  assert.equal(
    textUtils.trimText("  alpha\n beta\t gamma  ", 12),
    "alpha beta…",
  );
  assert.deepEqual(
    textUtils.uniqueStrings([" Alpha ", "alpha", "Beta", "beta ", ""]),
    ["Alpha", "Beta"],
  );
  assert.deepEqual(
    textUtils.normalizeStringList([" Alpha ", "alpha", " 42 ", 42, ""]),
    ["Alpha", "42"],
  );
  assert.deepEqual(textUtils.normalizeStringList(null), []);
  assert.deepEqual(
    textUtils.normalizeStringList(new Set([" Memory ", "memory", "FETCH"]), {
      lowercase: true,
    }),
    ["memory", "fetch"],
  );
  assert.deepEqual(
    textUtils.normalizeStringList([" First ", "first", "SECOND"], {
      lowercase: false,
    }),
    ["First", "SECOND"],
  );
  assert.equal(textUtils.normalizeNeedle("  Hello\nWORLD  "), "hello world");
  assert.deepEqual(
    textUtils.latinTokens("Demo/path demo_path B x yz HTTP/API"),
    ["demo/path", "demo_path", "http/api"],
  );
  assert.deepEqual(
    textUtils.latinTokens("foo//bar /baz/ gpt-5 gpt-5 __ cache__/tmp"),
    ["foo", "bar", "baz", "gpt-5", "cache", "tmp"],
  );
  assert.deepEqual(textUtils.latinTokens("HTTP/API http/api Gpt-5 gpt-5"), [
    "http/api",
    "gpt-5",
  ]);
});
