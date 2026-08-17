import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { runPiInteractiveModeInit } from "../../src/core/pi/private-api.js";

test("Rin delegates initialization to Pi's native lifecycle without managed-tool downloads", async (t) => {
  const previousPiOffline = process.env.PI_OFFLINE;
  t.after(() => {
    if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousPiOffline;
  });
  process.env.PI_OFFLINE = "owner-before-init";
  const receiver: any = {};

  const result = await runPiInteractiveModeInit(
    async function nativeInit(this: any, marker: string) {
      assert.equal(process.env.PI_OFFLINE, "1");
      this.fullscreenLayoutRoot = { owner: "pi", marker };
      return "native-result";
    },
    receiver,
    ["fullscreen"],
  );

  assert.equal(result, "native-result");
  assert.deepEqual(receiver.fullscreenLayoutRoot, {
    owner: "pi",
    marker: "fullscreen",
  });
  assert.equal(process.env.PI_OFFLINE, "owner-before-init");
});
