#!/usr/bin/env node
import "../support/require-test-sandbox.ts";
import {
  isInnerContainerRun,
  runManualHarnessContainer,
  runManualInnerSession,
} from "../support/install-to-tui-harness.js";

async function main() {
  const args = process.argv.slice(2);
  const inner = args.includes("--inner") || isInnerContainerRun();
  const scripted = args.includes("--scripted");

  if (inner) {
    await runManualInnerSession({ scripted });
    return;
  }

  await runManualHarnessContainer({ scripted });
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
