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

test("Pi private API exposes the managed tools module", async () => {
  const moduleUrl = privateApi.getPiToolsManagerModuleUrl();
  assert.match(moduleUrl, /pi-coding-agent\/dist\/utils\/tools-manager\.js$/);
  const tools = await privateApi.loadPiToolsManagerModule();
  assert.equal(typeof tools.ensureTool, "function");
  assert.equal(typeof tools.getToolPath, "function");

  const custom = await privateApi.loadPiToolsManagerModule(
    "data:text/javascript,export const getToolPath=(name)=>`custom:${name}`",
  );
  assert.equal(custom.getToolPath?.("rg"), "custom:rg");
  assert.equal(custom.ensureTool, undefined);
});
