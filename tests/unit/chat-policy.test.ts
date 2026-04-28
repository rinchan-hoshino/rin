import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const support = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "support.js")).href
);

test("chat policy allows trusted users to check status, abort, and start new chat sessions", () => {
  assert.equal(support.canRunCommand("TRUSTED", "status"), true);
  assert.equal(support.canRunCommand("TRUSTED", "new"), true);
  assert.equal(support.canRunCommand("TRUSTED", "abort"), true);
});

test("chat policy still blocks higher-impact chat commands for trusted users", () => {
  assert.equal(support.canRunCommand("TRUSTED", "model"), false);
  assert.equal(support.canRunCommand("TRUSTED", "reload"), false);
  assert.equal(support.canRunCommand("TRUSTED", "compact"), false);
});

test("chat policy keeps non-help commands restricted while owners retain other command access", () => {
  assert.equal(support.canRunCommand("OTHER", "help"), false);
  assert.equal(support.canRunCommand("OTHER", "abort"), false);
  assert.equal(support.canRunCommand("OWNER", "abort"), true);
  assert.equal(support.canRunCommand("OWNER", "model"), true);
});

test("chat policy does not reserve a special /auth bootstrap command", () => {
  assert.equal(
    support.canRunCommand("OTHER", "auth", { hasOwner: false }),
    false,
  );
  assert.equal(
    support.canRunCommand("OTHER", "auth", { hasOwner: true }),
    false,
  );
  assert.equal(
    support.canRunCommand("TRUSTED", "auth", { hasOwner: true }),
    false,
  );
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
      trust: "trusted",
      mentionLike: true,
      commandLike: true,
    }),
    false,
  );
  assert.equal(support.canRunCommand(" trusted ", "/status"), true);
  assert.equal(support.canRunCommand(" owner ", "/abort"), true);
  assert.equal(support.canRunCommand("invalid", "/status"), false);
});
