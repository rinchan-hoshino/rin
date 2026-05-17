import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const capabilitySession = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "capability-session.js"),
  ).href
);

test("Rin capabilities do not add lifecycle hooks to the Pi extension runner", async () => {
  const capabilitySet = capabilitySession.createRinCapabilitySet({
    cwd: "/tmp/rin-capability-session-test",
    agentDir: "/tmp/rin-capability-session-test",
    sessionManager: {
      appendCustomEntry() {},
    },
    definitions: [
      {
        name: "demo_sync_compaction",
        hooks: {
          session_before_compact: [async () => ({ rinResult: true })],
        },
      },
    ],
  });

  const extensionRunner = {
    hasHandlers() {
      return false;
    },
    async emit() {
      return undefined;
    },
    getRegisteredCommands() {
      return [];
    },
  };
  const session = {
    _extensionRunner: extensionRunner,
    sessionManager: {
      appendCustomEntry() {},
    },
    subscribe() {
      return () => {};
    },
  };

  await capabilitySession.attachRinCapabilitiesToSession(session, {
    capabilitySet,
  });

  assert.equal(
    session._extensionRunner.hasHandlers("session_before_compact"),
    false,
  );
  assert.equal(session._extensionRunner.hasHandlers("session_shutdown"), false);
});
