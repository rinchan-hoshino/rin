import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const {
  ProcessTerminationRequest,
  processTerminationExitCode,
  requestProcessTermination,
} = await importBuiltModule<
  typeof import("../../src/core/platform/process-lifetime.js")
>("dist/core/platform/process-lifetime.js");

test("process termination requests carry only a validated host exit intent", () => {
  assert.throws(
    () => requestProcessTermination(143),
    (error: unknown) => {
      assert.equal(error instanceof ProcessTerminationRequest, true);
      assert.equal(processTerminationExitCode(error), 143);
      return true;
    },
  );
  assert.equal(processTerminationExitCode(new Error("ordinary")), undefined);
  for (const invalidExitCode of [-1, 256, 1.5]) {
    assert.throws(
      () => new ProcessTerminationRequest(invalidExitCode),
      /exit code must be an integer from 0 to 255/i,
    );
  }
});
