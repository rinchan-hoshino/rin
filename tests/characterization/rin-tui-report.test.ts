import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const tuiReport = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "tui-report.js")).href
);

test("renderReportSection keeps compact note-friendly text", () => {
  const text = tuiReport.renderReportSection({
    lines: ["alpha", "", "beta  ", ""],
  });
  assert.equal(text, "alpha\nbeta");
});
