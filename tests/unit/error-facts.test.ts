import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const errors = await import(
  pathToFileURL(path.resolve("dist/core/rin-lib/error-facts.js")).href
);

test("error facts preserve raw identity without presentation", () => {
  assert.equal(
    errors.rawErrorMessage(new Error("owner marker")),
    "owner marker",
  );
  assert.equal(errors.rawErrorMessage("plain"), "plain");
  assert.equal(errors.rawErrorMessage({}), "[object Object]");
  assert.equal(errors.rawErrorMessage(null), "");
  assert.equal(errors.rawErrorMessage({ message: "" }), "[object Object]");
  assert.equal(Object.keys(errors).sort().join(","), "rawErrorMessage");
});
