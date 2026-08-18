import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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

  const session = {
    agent: {
      async transformContext(messages: any[]) {
        calls.push(`pi-context:${messages[0].content}`);
        return [{ role: "user", content: "pi" }];
      },
    },
    subscribe() {
      return () => {};
    },
  };

  await capabilitySession.attachRinCapabilitiesToSession(session, {
    capabilitySet,
  });

  const result = await session.agent.transformContext([
    { role: "user", content: "raw" },
  ]);

  assert.deepEqual(calls, ["pi-context:raw", "rin:pi"]);
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
    thinkingLevel: "high",
    getActiveToolNames: () => ["read"],
    getToolDefinition: () => undefined,
    resourceLoader: {},
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
  assert.equal(context.thinkingLevel, "high");
  assert.equal(
    context.getSystemPromptOptions().cwd,
    "/tmp/rin-capability-session-test",
  );
  assert.deepEqual(context.getSystemPromptOptions().selectedTools, ["read"]);
  const commandContext = capabilitySet.createCommandContext();
  assert.equal(commandContext.thinkingLevel, "high");
  assert.equal(
    commandContext.getSystemPromptOptions().cwd,
    "/tmp/rin-capability-session-test",
  );
  assert.deepEqual(commandContext.getSystemPromptOptions().selectedTools, [
    "read",
  ]);
});

test("Rin context ownership survives session reload without extension-runner patches", async () => {
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
  const session = {
    agent: {
      async transformContext(messages: any[]) {
        calls.push(`pi:${messages[0].content}`);
        return messages;
      },
    },
    async reload() {
      calls.push("reload");
    },
    subscribe() {
      return () => {};
    },
  };

  await capabilitySession.attachRinCapabilitiesToSession(session, {
    capabilitySet,
  });
  const transform = session.agent.transformContext;
  await session.reload();
  assert.equal(session.agent.transformContext, transform);
  const result = await session.agent.transformContext([
    { role: "user", content: "raw" },
  ]);

  assert.deepEqual(calls, ["reload", "pi:raw", "rin:raw"]);
  assert.deepEqual(result, [
    { role: "user", content: "raw" },
    { role: "system", content: "rin" },
  ]);
});
