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

test("Rin capability session_before_compact hooks are exposed as awaited Pi extension hooks", async () => {
  const calls: string[] = [];
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
          session_before_compact: [
            async (event: any) => {
              calls.push(`rin-start:${event.reason}`);
              await Promise.resolve();
              calls.push("rin-end");
              return { rinResult: true };
            },
          ],
        },
      },
    ],
  });

  const extensionRunner = {
    hasHandlers(eventName: string) {
      calls.push(`pi-has:${eventName}`);
      return false;
    },
    async emit(event: any) {
      calls.push(`pi-emit:${event.type}`);
      return undefined;
    },
    getRegisteredCommands() {
      return [];
    },
  };
  const session = {
    _extensionRunner: extensionRunner,
    __rinCurrentCompactionReason: "threshold",
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

  calls.length = 0;
  assert.equal(
    session._extensionRunner.hasHandlers("session_before_compact"),
    true,
  );
  const result = await session._extensionRunner.emit({
    type: "session_before_compact",
  });

  assert.deepEqual(calls, [
    "pi-has:session_before_compact",
    "pi-emit:session_before_compact",
    "rin-start:threshold",
    "rin-end",
  ]);
  assert.deepEqual(result, { rinResult: true });
});
