import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const sdk = await importBuiltModule<
  typeof import("../../src/core/rin-frontend-sdk/index.js")
>("dist/core/rin-frontend-sdk/index.js");

test("frontend SDK index exposes the supported runtime surface", () => {
  for (const name of [
    "createRinFrontendBackendEventTranslator",
    "createFrontendSdkRuntimeWrapper",
    "resolveRinFrontendCommandResponses",
    "submitNativeFrontendPromptTurn",
    "replayPendingTerminalTurnEvent",
  ]) {
    assert.equal(
      typeof (sdk as Record<string, unknown>)[name],
      "function",
      name,
    );
  }
  assert.equal(typeof sdk.FRONTEND_SDK_RUNTIME_WRAPPER_KEY, "symbol");
});
