import test from "node:test";
import assert from "node:assert/strict";

import {
  assertInstalledRuntimeSmoke,
  isInnerContainerRun,
  runInstallToTuiSmokeInContainer,
} from "../support/install-to-tui-harness.js";

test("installed runtime TUI survives isolated daemon replacement and resync", async (t) => {
  if (!isInnerContainerRun()) {
    const result = await runInstallToTuiSmokeInContainer({
      failOnUnavailableRuntime: Boolean(
        process.env.CI || process.env.GITHUB_ACTIONS,
      ),
    });
    if (result.skipped) t.skip(result.skipped);
    return;
  }

  await assert.doesNotReject(() => assertInstalledRuntimeSmoke());
});
