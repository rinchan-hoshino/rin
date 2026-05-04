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

test("chat capability no longer exposes chat helper tools", () => {
  const definition = chatModule.default();
  assert.deepEqual(definition.tools || [], []);
  assert.ok(
    (definition.commands || []).some((command) => command.name === "chat"),
    "chat adapter setup remains a slash command",
  );
});
