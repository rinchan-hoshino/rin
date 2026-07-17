import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const bridge = await importBuiltModule<
  typeof import("../../src/core/pi/internal-extension-bridge.js")
>("dist/core/pi/internal-extension-bridge.js");

test("capability bridge adds canonical frontend and compaction metadata", () => {
  const session = {
    sessionManager: {
      __rinFrontend: { kind: "chat", key: "telegram/bot:owner" },
    },
    __rinCurrentCompactionReason: "manual",
  };
  assert.equal(bridge.withRinEventMetadata(null, session), null);
  assert.deepEqual(bridge.withRinEventMetadata({}, {}), {});
  assert.deepEqual(bridge.withRinEventMetadata({ type: "message" }, session), {
    type: "message",
    frontend: { kind: "chat", key: "telegram/bot:owner" },
  });
  assert.deepEqual(
    bridge.withRinEventMetadata(
      {
        type: "session_before_compact",
        frontend: { kind: "tui", key: "main" },
      },
      session,
    ),
    {
      type: "session_before_compact",
      frontend: { kind: "tui", key: "main" },
      reason: "manual",
    },
  );
  assert.equal(
    bridge.withRinEventMetadata(
      { type: "session_before_compact", reason: "auto" },
      session,
    ).reason,
    "auto",
  );
});

test("capability bridge composes Pi and Rin handler contracts without replacing Pi results", async () => {
  const piEvents: any[] = [];
  const rinEvents: any[] = [];
  const runner: any = {
    hasHandlers: (name: string) => name === "pi-only",
    async emit(event: any) {
      piEvents.push(event);
      if (event.type === "cancelled") return { cancel: true, source: "pi" };
      if (event.type === "context") return { messages: ["pi"], pi: true };
      if (event.type === "session_before_compact") return { pi: true };
      if (event.type === "empty") return undefined;
      return { source: "pi" };
    },
    async emitContext(messages: any[]) {
      return [...messages, "pi-context"];
    },
  };
  const capabilitySet = {
    hasHandlers: (name: string) =>
      name === "context" || name === "session_before_compact",
    async emit(event: any) {
      rinEvents.push(event);
      if (event.type === "context")
        return { messages: [...event.messages, "rin-context"], rin: true };
      return { compaction: { summary: "rin" }, rin: true };
    },
  };
  const session: any = {
    extensionRunner: runner,
    sessionManager: { __rinFrontend: { kind: "rpc", key: "owner" } },
    __rinCurrentCompactionReason: "manual",
  };
  bridge.attachRinCapabilityExtensionBridge(session, capabilitySet);

  assert.equal(runner.hasHandlers("pi-only"), true);
  assert.equal(runner.hasHandlers("context"), true);
  assert.equal(runner.hasHandlers("unsupported"), false);
  assert.deepEqual(await runner.emitContext(["owner"]), [
    "owner",
    "pi-context",
    "rin-context",
  ]);
  assert.deepEqual(
    await runner.emit({ type: "context", messages: ["owner"] }),
    {
      messages: ["pi", "rin-context"],
      pi: true,
      rin: true,
    },
  );
  assert.deepEqual(await runner.emit({ type: "session_before_compact" }), {
    compaction: { summary: "rin" },
    rin: true,
  });
  assert.deepEqual(await runner.emit({ type: "other" }), { source: "pi" });
  assert.equal(piEvents.length, 3);
  assert.deepEqual(rinEvents.at(-1), {
    type: "session_before_compact",
    frontend: { kind: "rpc", key: "owner" },
    reason: "manual",
  });

  const replacementEvents: any[] = [];
  bridge.attachRinCapabilityExtensionBridge(
    { ...session, __rinCurrentCompactionReason: "auto" },
    {
      hasHandlers: () => true,
      async emit(event: any) {
        replacementEvents.push(event);
        return { cancel: true };
      },
    },
  );
  assert.deepEqual(await runner.emit({ type: "session_before_compact" }), {
    cancel: true,
  });
  assert.equal(replacementEvents[0].reason, "auto");
});

test("capability bridge preserves fallback messages, cancellation, and empty Pi results", async () => {
  const noContextHandler = {
    hasHandlers: () => false,
    emit: async () => assert.fail("unexpected Rin event"),
  };
  const runner: any = {
    hasHandlers: () => false,
    emitContext: async () => undefined,
    emit: async (event: any) =>
      event.type === "session_before_compact" ? { cancel: true } : undefined,
  };
  bridge.attachRinCapabilityExtensionBridge(
    { extensionRunner: runner },
    noContextHandler,
  );
  assert.deepEqual(await runner.emitContext(["original"]), ["original"]);
  assert.deepEqual(await runner.emit({ type: "session_before_compact" }), {
    cancel: true,
  });
  assert.equal(await runner.emit({ type: "context", messages: [] }), undefined);

  bridge.attachRinCapabilityExtensionBridge({}, noContextHandler);
  bridge.attachRinCapabilityExtensionBridge(
    { extensionRunner: { hasHandlers: true, emit: undefined } },
    noContextHandler,
  );

  const noContextRunner: any = {
    hasHandlers: () => false,
    emit: async () => undefined,
  };
  bridge.attachRinCapabilityExtensionBridge(
    { extensionRunner: noContextRunner },
    {
      hasHandlers: (name: string) => name === "context",
      async emit() {
        return { messages: "invalid" };
      },
    },
  );
  assert.equal(noContextRunner.hasHandlers(undefined), false);
  assert.equal(await noContextRunner.emit({}), undefined);
  assert.equal(noContextRunner.emitContext, undefined);
});
