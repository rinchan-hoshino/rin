import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertOptionalExtensionSmoke,
  isInnerContainerRun,
  isLocalCiContainerRun,
  remapInstalledRuntimeCoverage,
  runInstallToTuiSmokeInContainer,
} from "../support/install-to-tui-harness.js";

test("installed runtime loads an explicit optional extension through the TUI", async () => {
  try {
    if (!isInnerContainerRun()) {
      await runInstallToTuiSmokeInContainer({
        testFile: "tests/system/optional-extension-user-flow.test.ts",
      });
      return;
    }

    await assert.doesNotReject(() => assertOptionalExtensionSmoke());
  } finally {
    if (isLocalCiContainerRun()) await remapInstalledRuntimeCoverage();
  }
});
