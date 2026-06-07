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

test("Rin core capability events reach session subscribers without extension UI", async () => {
  const capabilitySet = capabilitySession.createRinCapabilitySet({
    cwd: "/tmp/rin-capability-session-test",
    agentDir: "/tmp/rin-capability-session-test",
    definitions: [],
  });
  const nativeListeners = new Set<(event: any) => void>();
  const session = {
    subscribe(listener: (event: any) => void) {
      nativeListeners.add(listener);
      return () => nativeListeners.delete(listener);
    },
  };

  await capabilitySession.attachRinCapabilitiesToSession(session, {
    capabilitySet,
  });

  const seen: any[] = [];
  session.subscribe((event: any) => seen.push(event));
  capabilitySet.createContext().emitEvent({
    type: "demo_capability_event",
    status: "completed",
  });

  assert.deepEqual(seen, [
    { type: "demo_capability_event", status: "completed" },
  ]);
});

test("Rin context hooks transform provider-bound messages after Pi emitContext", async () => {
  const calls: string[] = [];
  const capabilitySet = capabilitySession.createRinCapabilitySet({
    cwd: "/tmp/rin-capability-session-test",
    agentDir: "/tmp/rin-capability-session-test",
    definitions: [
      {
        name: "demo_context",
        hooks: {
          context: [
            async (event: any) => {
              calls.push(`rin:${event.messages[0].content}`);
              return {
                messages: [
                  ...event.messages,
                  { role: "system", content: "rin" },
                ],
              };
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
      return { messages: [{ role: "user", content: "pi" }], pi: true };
    },
    async emitContext(messages: any[]) {
      calls.push(`pi-context:${messages[0].content}`);
      return [{ role: "user", content: "pi" }];
    },
    getRegisteredCommands() {
      return [];
    },
  };
  const session = {
    _extensionRunner: extensionRunner,
    subscribe() {
      return () => {};
    },
  };

  await capabilitySession.attachRinCapabilitiesToSession(session, {
    capabilitySet,
  });

  assert.equal(session._extensionRunner.hasHandlers("context"), true);
  const result = await session._extensionRunner.emitContext([
    { role: "user", content: "raw" },
  ]);

  assert.deepEqual(calls, ["pi-has:context", "pi-context:raw", "rin:pi"]);
  assert.deepEqual(result, [
    { role: "user", content: "pi" },
    { role: "system", content: "rin" },
  ]);
});

test("Rin capability context exposes Pi extension mode and prompt options", async () => {
  const capabilitySet = capabilitySession.createRinCapabilitySet({
    cwd: "/tmp/rin-capability-session-test",
    agentDir: "/tmp/rin-capability-session-test",
    definitions: [],
  });
  const session = {
    _baseSystemPromptOptions: {
      cwd: "/tmp/rin-capability-session-test",
      tools: ["read"],
    },
    _extensionMode: "rpc",
    _extensionRunner: {
      hasHandlers() {
        return false;
      },
      async emit() {
        return undefined;
      },
      getRegisteredCommands() {
        return [];
      },
    },
    subscribe() {
      return () => {};
    },
  };

  await capabilitySession.attachRinCapabilitiesToSession(session, {
    capabilitySet,
  });

  const context = capabilitySet.createContext();
  assert.equal(context.mode, "rpc");
  assert.deepEqual(context.getSystemPromptOptions(), {
    cwd: "/tmp/rin-capability-session-test",
    tools: ["read"],
  });
  assert.deepEqual(
    capabilitySet.createCommandContext().getSystemPromptOptions(),
    {
      cwd: "/tmp/rin-capability-session-test",
      tools: ["read"],
    },
  );
});

test("Rin compaction hook errors propagate instead of falling back to Pi summarization", async () => {
  const recorded: any[] = [];
  const capabilitySet = capabilitySession.createRinCapabilitySet({
    cwd: "/tmp/rin-capability-session-test",
    agentDir: "/tmp/rin-capability-session-test",
    sessionManager: {
      appendCustomEntry(type: string, data: any) {
        recorded.push({ type, data });
      },
    },
    definitions: [
      {
        name: "demo_failing_compaction",
        hooks: {
          session_before_compact: [
            async () => {
              throw new Error("summary failed");
            },
          ],
        },
      },
    ],
  });

  await assert.rejects(
    () => capabilitySet.emit({ type: "session_before_compact" }),
    /summary failed/,
  );
  assert.equal(recorded[0].type, "rin_core_capability_error");
  assert.equal(recorded[0].data.event, "session_before_compact");
});

test("Rin compaction hooks are exposed through Pi's native before-compact span", async () => {
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
              calls.push(`rin:${event.reason}`);
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
    __rinCurrentCompactionReason: "overflow",
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
    "rin:overflow",
  ]);
  assert.deepEqual(result, { rinResult: true });
  assert.equal(session._extensionRunner.hasHandlers("session_shutdown"), false);
});

test("Rin capability bridge is reattached to Pi extension runner after reload", async () => {
  const calls: string[] = [];
  const capabilitySet = capabilitySession.createRinCapabilitySet({
    cwd: "/tmp/rin-capability-session-test",
    agentDir: "/tmp/rin-capability-session-test",
    definitions: [
      {
        name: "demo_context_after_reload",
        hooks: {
          context: [
            async (event: any) => {
              calls.push(`rin:${event.messages[0].content}`);
              return {
                messages: [
                  ...event.messages,
                  { role: "system", content: "rin" },
                ],
              };
            },
          ],
        },
      },
    ],
  });

  const makeRunner = (label: string) => ({
    hasHandlers(eventName: string) {
      calls.push(`${label}-has:${eventName}`);
      return false;
    },
    async emit(event: any) {
      calls.push(`${label}-emit:${event.type}`);
      return undefined;
    },
    async emitContext(messages: any[]) {
      calls.push(`${label}-context:${messages[0].content}`);
      return messages;
    },
    getRegisteredCommands() {
      return [];
    },
  });

  const session = {
    _extensionRunner: makeRunner("before"),
    async reload() {
      calls.push("reload");
      this._extensionRunner = makeRunner("after");
    },
    subscribe() {
      return () => {};
    },
  };

  await capabilitySession.attachRinCapabilitiesToSession(session, {
    capabilitySet,
  });

  calls.length = 0;
  await session.reload();
  assert.equal(session._extensionRunner.hasHandlers("context"), true);
  const result = await session._extensionRunner.emitContext([
    { role: "user", content: "raw" },
  ]);

  assert.deepEqual(calls, [
    "reload",
    "after-has:context",
    "after-context:raw",
    "rin:raw",
  ]);
  assert.deepEqual(result, [
    { role: "user", content: "raw" },
    { role: "system", content: "rin" },
  ]);
});
