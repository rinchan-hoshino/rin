import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const commandResponses = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat", "command-responses.js"),
  ).href
);

test("chat command responses default to English when config file is absent", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-command-copy-"),
  );

  assert.equal(
    commandResponses.readChatCommandResponses(agentDir).new,
    "Started a new session.",
  );
});

test("chat command responses can be overridden from a standalone config file", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-command-copy-"),
  );
  const customNew = String.fromCharCode(
    0x5df2,
    0x5f00,
    0x59cb,
    0x65b0,
    0x4f1a,
    0x8bdd,
    0x3002,
  );
  await fs.writeFile(
    commandResponses.chatCommandResponsesPath(agentDir),
    JSON.stringify({ new: customNew }),
  );

  const responses = commandResponses.readChatCommandResponses(agentDir);
  assert.equal(responses.new, customNew);
  assert.equal(responses.abort, "Aborted current operation.");
});
