import assert from "node:assert/strict";
import test from "node:test";

import {
  ProcessTerminationRequest,
  processTerminationExitCode,
  requestProcessTermination,
} from "../../src/core/platform/process-lifetime.js";

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
  assert.throws(
    () => new ProcessTerminationRequest(-1),
    /exit code must be an integer from 0 to 255/i,
  );
});
