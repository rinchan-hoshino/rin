import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const support = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href
);

test("chat policy allows owners and trusted users to run chat commands", () => {
  assert.equal(support.canRunCommand("TRUSTED", "new"), true);
  assert.equal(support.canRunCommand("TRUSTED", "abort"), true);
  assert.equal(support.canRunCommand("TRUSTED", "usage"), true);
  assert.equal(support.canRunCommand("TRUSTED", "reload"), true);
  assert.equal(support.canRunCommand("TRUSTED", "compact"), true);
  assert.equal(support.canRunCommand("TRUSTED", "help"), true);
  assert.equal(support.canRunCommand("OWNER", "help"), true);
  assert.equal(support.canRunCommand("OWNER", "usage"), true);
});

test("chat policy blocks command execution for untrusted or blank command inputs", () => {
  assert.equal(support.canRunCommand("OTHER", "help"), false);
  assert.equal(support.canRunCommand("OTHER", "abort"), false);
  assert.equal(support.canRunCommand("invalid", "usage"), false);
  assert.equal(support.canRunCommand("TRUSTED", ""), false);
  assert.equal(support.canRunCommand("OWNER", "  "), false);
});

test("chat policy normalizes trust values for input access and command checks", () => {
  assert.equal(
    support.canAccessAgentInput({
      chatType: "private",
      trust: " owner ",
      mentionLike: false,
      commandLike: false,
    }),
    true,
  );
  assert.equal(
    support.canAccessAgentInput({
      chatType: "private",
      trust: " trusted ",
      mentionLike: false,
      commandLike: false,
    }),
    true,
  );
  assert.equal(
    support.canAccessAgentInput({
      chatType: "group",
      trust: " trusted ",
      mentionLike: true,
      commandLike: false,
    }),
    true,
  );
  assert.equal(
    support.canAccessAgentInput({
      chatType: "group",
      trust: " trusted ",
      mentionLike: false,
      commandLike: false,
    }),
    false,
  );
  assert.equal(
    support.canAccessAgentInput({
      chatType: "group",
      trust: " owner ",
      mentionLike: false,
      commandLike: false,
      allowWithoutMention: true,
    }),
    true,
  );
  assert.equal(
    support.canAccessAgentInput({
      chatType: "group",
      trust: "trusted",
      mentionLike: true,
      commandLike: true,
    }),
    false,
  );
  assert.equal(support.canRunCommand(" trusted ", "/usage"), true);
  assert.equal(support.canRunCommand(" owner ", "/abort"), true);
  assert.equal(support.canRunCommand("invalid", "/usage"), false);
});
