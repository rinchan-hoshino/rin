import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const chatModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "index.js")).href
);
const { BUILTIN_SLASH_COMMANDS } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "rpc.js")).href
);

test("chat capability no longer exposes chat helper tools or command sidecars", () => {
  const definition = chatModule.default();
  assert.deepEqual(definition.tools || [], []);
  assert.equal(definition.commands, undefined);
  assert.ok(
    BUILTIN_SLASH_COMMANDS.some((command) => command.name === "chat"),
    "chat adapter setup is a built-in slash command",
  );
});
