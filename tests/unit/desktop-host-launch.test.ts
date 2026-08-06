import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const launch = await importBuiltModule<{
  DEFAULT_RIN_DESKTOP_HOST: string;
  buildDesktopHostLaunch(
    env: Record<string, string | undefined>,
    names: readonly string[],
    trailing: readonly string[],
    fallback?: string,
  ): { command: string; args: string[] };
}>("dist/core/rin-gui/host-launch.js");

test("desktop host launch selects the first configured command and appends arguments", () => {
  assert.deepEqual(
    launch.buildDesktopHostLaunch(
      { FIRST: " ", SECOND: " custom-host --flag  value " },
      ["FIRST", "SECOND"],
      ["--url", "http://127.0.0.1"],
    ),
    {
      command: "custom-host",
      args: ["--flag", "value", "--url", "http://127.0.0.1"],
    },
  );
});

test("desktop host launch falls back for absent and whitespace-only commands", () => {
  assert.deepEqual(launch.buildDesktopHostLaunch({}, ["HOST"], []), {
    command: launch.DEFAULT_RIN_DESKTOP_HOST,
    args: [],
  });
  assert.deepEqual(
    launch.buildDesktopHostLaunch({}, [], ["tail"], " custom "),
    {
      command: "custom",
      args: ["tail"],
    },
  );
  assert.deepEqual(launch.buildDesktopHostLaunch({}, [], [], "   "), {
    command: launch.DEFAULT_RIN_DESKTOP_HOST,
    args: [],
  });
});
