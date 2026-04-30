import test from "node:test";
import assert from "node:assert/strict";

import {
  assertInstalledRuntimeSmoke,
  isInnerContainerRun,
  runInstallToTuiSmokeInContainer,
} from "../support/install-to-tui-harness.js";

test("installed runtime can reach an isolated interactive TUI user flow", async (t) => {
  if (!isInnerContainerRun()) {
    const result = await runInstallToTuiSmokeInContainer({
      failOnMissingRuntime: Boolean(
        process.env.CI || process.env.GITHUB_ACTIONS,
      ),
    });
    if (result.skipped) t.skip(result.skipped);
    return;
  }

  await assert.doesNotReject(() => assertInstalledRuntimeSmoke());
});
