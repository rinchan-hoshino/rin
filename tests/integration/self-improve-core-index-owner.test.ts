import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const core = await importBuiltModule<
  typeof import("../../src/core/self-improve/core/index.js")
>("dist/core/self-improve/core/index.js");

test("self-improve core index exposes the canonical store operations", () => {
  for (const operation of [
    "ensureSelfImproveLayout",
    "loadActiveSelfImproveDocs",
    "compileSelfImprove",
    "executeSelfImproveAction",
  ]) {
    assert.equal(
      typeof (core as Record<string, unknown>)[operation],
      "function",
      operation,
    );
  }
});
