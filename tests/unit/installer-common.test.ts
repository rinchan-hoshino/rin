import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const common = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "common.js"))
    .href
);

test("installer runCommand uses shell for Windows cmd launchers", () => {
  assert.equal(
    common.shouldRunCommandThroughShell(
      "C:\\Users\\demo\\.local\\bin\\rin.cmd",
      "win32",
    ),
    true,
  );
  assert.equal(
    common.shouldRunCommandThroughShell(
      "C:\\Users\\demo\\.local\\bin\\rin-install.BAT",
      "win32",
    ),
    true,
  );
  assert.equal(
    common.shouldRunCommandThroughShell(
      "C:\\Program Files\\nodejs\\node.exe",
      "win32",
    ),
    false,
  );
  assert.equal(
    common.shouldRunCommandThroughShell("/home/demo/.local/bin/rin", "linux"),
    false,
  );
});
