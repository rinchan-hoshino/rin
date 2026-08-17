import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const privateApi = await importBuiltModule<
  typeof import("../../src/core/pi/private-api.js")
>("dist/core/pi/private-api.js");

test("Pi private API recognizes skill reads across supported argument shapes", () => {
  assert.equal(privateApi.isPiCompactSkillReadCall(null, "/tmp"), false);
  assert.equal(
    privateApi.isPiCompactSkillReadCall({ path: "docs/README.md" }, "/tmp"),
    false,
  );
  assert.equal(
    privateApi.isPiCompactSkillReadCall(
      { file_path: "skills/example/SKILL.md" },
      "/tmp",
    ),
    true,
  );
  assert.equal(
    privateApi.isPiCompactSkillReadCall(
      { path: "/tmp/skills/example/SKILL.md" },
      "",
    ),
    true,
  );
});

test("Pi private API reuses Pi command routing", async () => {
  assert.equal(await privateApi.handlePiPackageCommand([], {}), false);
  assert.equal(await privateApi.handlePiConfigCommand([], {}), false);
});

test("Pi private API delegates native initialization without tool downloads and restores offline state", async (t) => {
  const previousPiOffline = process.env.PI_OFFLINE;
  t.after(() => {
    if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousPiOffline;
  });
  process.env.PI_OFFLINE = "owner-before-init";
  const receiver: any = {};

  const result = await privateApi.runPiInteractiveModeInit(
    async function nativeInit(this: any, marker: string) {
      assert.equal(process.env.PI_OFFLINE, "1");
      this.fullscreenLayoutRoot = marker;
      return "native-result";
    },
    receiver,
    ["native-layout"],
  );

  assert.equal(result, "native-result");
  assert.equal(receiver.fullscreenLayoutRoot, "native-layout");
  assert.equal(process.env.PI_OFFLINE, "owner-before-init");

  delete process.env.PI_OFFLINE;
  await assert.rejects(
    privateApi.runPiInteractiveModeInit(async () => {
      throw new Error("native-init-failed");
    }, receiver),
    /native-init-failed/,
  );
  assert.equal(process.env.PI_OFFLINE, undefined);
});
