import assert from "node:assert/strict";
import test from "node:test";

import { formatInstallerProgressFailureMessage } from "../../src/core/rin-install/progress.js";

test("installer progress failure keeps the failed step specific", () => {
  const zhPublishingRuntime =
    "\u6b63\u5728\u53d1\u5e03\u8fd0\u884c\u65f6\u5e76\u5199\u5165\u914d\u7f6e\u2026\u2026";
  const zhInstallStepFailed = "\u5b89\u88c5\u6b65\u9aa4\u5931\u8d25\u3002";
  const zhPublishingRuntimeFailed =
    "\u53d1\u5e03\u8fd0\u884c\u65f6\u5e76\u5199\u5165\u914d\u7f6e\u5931\u8d25\u3002";
  assert.equal(
    formatInstallerProgressFailureMessage(
      zhPublishingRuntime,
      zhInstallStepFailed,
    ),
    zhPublishingRuntimeFailed,
  );
  assert.equal(
    formatInstallerProgressFailureMessage(
      "Publishing runtime and writing configuration...",
      "Install step failed.",
    ),
    "Publishing runtime and writing configuration failed.",
  );
});
