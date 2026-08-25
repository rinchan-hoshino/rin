import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const { setSessionModel } = await importBuiltModule<
  typeof import("../../src/core/rin-daemon/rpc-session-command-handler.js")
>("dist/core/rin-daemon/rpc-session-command-handler.js");

test("persistent model mutations opt into Pi global-default persistence", async () => {
  const model = { provider: "owner", id: "model" };
  const calls: any[] = [];
  const session = {
    async setModel(...args: any[]) {
      calls.push(args);
    },
  };

  await setSessionModel(session, model);

  assert.deepEqual(calls, [[model, { persist: true }]]);
});
