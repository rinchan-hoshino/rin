import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const windowsCommand = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "platform", "windows-command.js"),
  ).href
);

test("Windows command quoting preserves the existing launcher contract", () => {
  assert.equal(windowsCommand.windowsCmdQuote("plain"), '"plain"');
  assert.equal(
    windowsCommand.windowsCmdQuote('C:\\Program Files\\say "hi".exe'),
    '"C:\\Program Files\\say ""hi"".exe"',
  );
  assert.equal(windowsCommand.windowsCmdQuote("a&b%name"), '"a&b%name"');
});
