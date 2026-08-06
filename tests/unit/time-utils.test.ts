import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const timeUtils = await importBuiltModule<{
  nowIso(): string;
  nowFileTimestamp(): string;
}>("dist/core/time-utils.js");

test("time utils return canonical ISO and filename-safe timestamps", () => {
  const before = Date.now();
  const iso = timeUtils.nowIso();
  const after = Date.now();
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(iso) >= before && Date.parse(iso) <= after);

  const fileTimestamp = timeUtils.nowFileTimestamp();
  assert.match(fileTimestamp, /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  assert.doesNotMatch(fileTimestamp, /[:.]/);
});
