import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertScheduledReminderDelivery,
  isInnerContainerRun,
  isLocalCiContainerRun,
  remapInstalledRuntimeCoverage,
  runInstallToTuiSmokeInContainer,
} from "../support/install-to-tui-harness.js";

test("a due reminder reaches its bound Chat conversation", async () => {
  try {
    if (!isInnerContainerRun()) {
      await runInstallToTuiSmokeInContainer({
        testFile: "tests/system/scheduled-reminder-user-flow.test.ts",
      });
      return;
    }

    await assert.doesNotReject(() => assertScheduledReminderDelivery());
  } finally {
    if (isLocalCiContainerRun()) await remapInstalledRuntimeCoverage();
  }
});
