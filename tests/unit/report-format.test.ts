import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const reportFormat = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "report-format.js"))
    .href
);

test("report formatting sizes colored text by visible width", () => {
  const colored = "\u001b[31mfailed\u001b[0m";
  assert.equal(reportFormat.stripAnsi(colored), "failed");
  assert.equal(reportFormat.truncateAnsi(colored, 4), "fai…");
  assert.equal(reportFormat.padAnsi(colored, 8), `${colored}  `);
});

test("report formatting handles narrow widths", () => {
  assert.equal(reportFormat.truncateAnsi("hello", 1), "h");
  assert.equal(reportFormat.truncateAnsi("hello", 0), "");
});
