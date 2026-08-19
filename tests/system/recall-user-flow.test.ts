import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRecallAcrossSessions,
  isInnerContainerRun,
  isLocalCiContainerRun,
  remapInstalledRuntimeCoverage,
  runInstallToTuiSmokeInContainer,
} from "../support/install-to-tui-harness.js";

test("a new TUI session can recall a prior conversation", async () => {
  try {
    if (!isInnerContainerRun()) {
      await runInstallToTuiSmokeInContainer({
        testFile: "tests/system/recall-user-flow.test.ts",
      });
      return;
    }

    await assert.doesNotReject(() => assertRecallAcrossSessions());
  } finally {
    if (isLocalCiContainerRun()) await remapInstalledRuntimeCoverage();
  }
});
