import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const report = await importBuiltModule<{
  renderReportSection(section: { lines: string[] }): string;
}>("dist/core/rin/tui-report.js");

test("TUI report sections trim line endings and remove empty rows", () => {
  assert.equal(
    report.renderReportSection({ lines: ["alpha", "", "beta  ", ""] }),
    "alpha\nbeta",
  );
  assert.equal(report.renderReportSection({ lines: [] }), "");
  assert.equal(
    report.renderReportSection({ lines: ["  ", " value "] }),
    " value",
  );
});
