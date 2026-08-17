import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const report = await importBuiltModule<{
  formatReportTime(value: unknown): string;
  renderReportTable(
    rows: Array<Record<string, unknown>>,
    columns: string[],
    options?: { emptyText?: string; indent?: string; maxColumnWidth?: number },
  ): string;
}>("dist/core/rin/report-format.js");

test("report time preserves blanks, invalid text, and formats valid timestamps", () => {
  assert.equal(report.formatReportTime(" "), "-");
  assert.equal(report.formatReportTime("not-a-date"), "not-a-date");
  const timestamp = "2026-07-16T00:00:00.000Z";
  assert.equal(
    report.formatReportTime(timestamp),
    new Date(timestamp).toLocaleString(),
  );
});

test("report tables align values, truncate wide cells, indent, and handle empties", () => {
  assert.equal(report.renderReportTable([], ["name"]), "(no rows)");
  assert.equal(
    report.renderReportTable([], ["name"], {
      emptyText: "empty",
      indent: "> ",
    }),
    "> empty",
  );
  const rendered = report.renderReportTable(
    [
      { name: "alpha", value: 1 },
      { name: "a very long name", value: null },
    ],
    ["name", "value"],
    { indent: "  ", maxColumnWidth: 8 },
  );
  const lines = rendered.split("\n");
  assert.equal(lines.length, 4);
  assert.ok(lines.every((line) => line.startsWith("  ")));
  assert.match(rendered, /a very …/);
  assert.match(rendered, /alpha/);
  assert.equal(
    report.renderReportTable([{ x: "long" }], ["x"], {
      maxColumnWidth: 1,
    }),
    "x\n-\nl",
  );
  assert.match(report.renderReportTable([{ x: "value" }], ["x"]), /value/);
});
