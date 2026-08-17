import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const chatDate = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "date.js")).href
);

test("formatLocalDateOnly keeps local calendar date formatting stable", () => {
  assert.equal(
    chatDate.formatLocalDateOnly(new Date(2026, 3, 23, 12, 34, 56)),
    "2026-04-23",
  );
});

test("normalizeLocalDateOnly accepts canonical and leading datetime text", () => {
  assert.equal(chatDate.normalizeLocalDateOnly("2026-04-23"), "2026-04-23");
  assert.equal(
    chatDate.normalizeLocalDateOnly(" 2026-04-23T12:34:56.000Z "),
    "2026-04-23",
  );
  assert.equal(
    chatDate.normalizeLocalDateOnly("2026-04-23 12:34:56"),
    "2026-04-23",
  );
});

test("normalizeLocalDateOnly rejects invalid text before using date-like fallbacks", () => {
  const fallback = new Date(2026, 3, 24, 9, 0, 0);

  assert.equal(
    chatDate.normalizeLocalDateOnly("2026-02-30", fallback),
    "2026-04-24",
  );
  assert.equal(
    chatDate.normalizeLocalDateOnly("2026-04-23abc", fallback),
    "2026-04-24",
  );
  assert.equal(
    chatDate.normalizeLocalDateOnly(new Date("invalid"), fallback),
    "2026-04-24",
  );
});

test("local date UTC bounds cover valid days and reject invalid fallbacks", () => {
  assert.deepEqual(chatDate.localDateUtcBounds("2026-04-23"), {
    start: new Date(2026, 3, 23).toISOString(),
    end: new Date(2026, 3, 24).toISOString(),
  });
  assert.equal(chatDate.localDateUtcBounds("invalid"), null);
  assert.equal(chatDate.normalizeLocalDateOnly(Infinity), "");
  assert.equal(chatDate.normalizeLocalDateOnly({}, null), "");
  assert.match(chatDate.formatLocalDateOnly(), /^\d{4}-\d{2}-\d{2}$/);
});

test("normalizeLocalDateOnly accepts Date and finite timestamp inputs", () => {
  const date = new Date(2026, 3, 25, 8, 0, 0);
  assert.equal(chatDate.normalizeLocalDateOnly(date), "2026-04-25");
  assert.equal(
    chatDate.normalizeLocalDateOnly(date.getTime()),
    chatDate.formatLocalDateOnly(date),
  );
});
