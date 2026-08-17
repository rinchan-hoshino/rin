import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const format = await importBuiltModule<
  Record<string, (...args: any[]) => string>
>("dist/core/rin-frontend-sdk/compaction-summary-format.js");

test("compaction token formatting rejects invalid counts and truncates finite values", () => {
  for (const value of [
    undefined,
    null,
    "bad",
    0,
    -1,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.equal(format.formatCompactionTokenCount(value), "");
  }
  assert.equal(
    format.formatCompactionTokenCount(1234.9).replace(/\D/g, ""),
    "1234",
  );
});

test("compaction title and hint formatting support defaults and explicit templates", () => {
  assert.match(
    format.formatCompactionSummaryTitle(1000),
    /^Compacted from .+ tokens$/,
  );
  assert.equal(
    format.formatCompactionSummaryTitle(12, { lineTemplate: "Used {tokens}" }),
    "Used 12",
  );
  assert.equal(format.formatCompactionSummaryTitle(0), "");
  assert.equal(
    format.formatCompactionExpandHint({ expandHintText: false }),
    "",
  );
  assert.equal(format.formatCompactionExpandHint({ expandHintText: null }), "");
  assert.equal(
    format.formatCompactionExpandHint({ expandHintText: " custom " }),
    "custom",
  );
  assert.equal(format.formatCompactionExpandHint({}), "");
  assert.equal(
    format.formatCompactionExpandHint({ expandKeyText: "ctrl+o" }),
    "(ctrl+o to expand)",
  );
  assert.equal(
    format.formatCompactionExpandHint({
      expandKeyText: "x",
      expandHintTemplate: "Press {expandKey}",
    }),
    "Press x",
  );
});

test("compaction collapsed output handles labels, hints, and wrappers", () => {
  assert.equal(format.formatCompactionSummaryCollapsedLine(0), "");
  assert.match(
    format.formatCompactionSummaryCollapsedLine(100, { expandKeyText: "e" }),
    /\(e to expand\)$/,
  );
  assert.equal(format.formatCompactionSummaryCollapsedText(0), "");
  assert.equal(
    format.formatCompactionSummaryCollapsedText(12, {
      includeLabel: false,
      titleTemplate: "T{tokens}",
    }),
    "T12",
  );
  assert.equal(
    format.formatCompactionSummaryCollapsedText(12, {
      textTemplate: "<{summary}>",
      titleTemplate: "T{tokens}",
    }),
    "<T12>",
  );
});
