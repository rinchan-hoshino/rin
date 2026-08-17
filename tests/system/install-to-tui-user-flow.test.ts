import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";

import {
  assertInstalledRuntimeSmoke,
  isInnerContainerRun,
  isLocalCiContainerRun,
  remapInstalledRuntimeCoverage,
  runInstallToTuiSmokeInContainer,
} from "../support/install-to-tui-harness.js";

test("installed runtime can reach an isolated interactive TUI user flow", async () => {
  try {
    if (!isInnerContainerRun()) {
      await runInstallToTuiSmokeInContainer();
      return;
    }

    await assert.doesNotReject(() => assertInstalledRuntimeSmoke());
  } finally {
    if (isLocalCiContainerRun()) await remapInstalledRuntimeCoverage();
  }
});
