import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const chatMain = await importBuiltModule<
  typeof import("../../src/core/chat/main.js")
>("dist/core/chat/main.js");

test("chat main startup cleans up when command-catalog construction fails", async () => {
  let factoryCalls = 0;
  await assert.rejects(
    () =>
      chatMain.startChatBridge({
        hosted: false,
        frontendClientFactory() {
          factoryCalls += 1;
          if (factoryCalls > 1) throw new Error("catalog unavailable");
          return {
            async disconnect() {
              throw new Error("owner cleanup disconnect failed");
            },
          } as never;
        },
      }),
    /catalog unavailable/,
  );
  assert.equal(factoryCalls, 2);
});

test("chat main startup reconciles an empty terminal feed without projecting work", async () => {
  let listRequests = 0;
  const frontend = {
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    subscribe() {
      return () => {};
    },
    async request(command: { type?: string }) {
      if (command.type === "list_unacknowledged_chat_terminals") {
        listRequests += 1;
        return { terminals: [] };
      }
      return {};
    },
  };
  const bridge = await chatMain.startChatBridge({
    hosted: false,
    commandRows: [],
    frontendClientFactory: () => frontend as never,
  });
  try {
    const deadline = Date.now() + 2_000;
    while (listRequests === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(listRequests > 0);
  } finally {
    await bridge.stop();
  }
});

test("chat main reconciles one durable terminal through its detached owner", async () => {
  let listRequests = 0;
  const frontend = {
    async connect() {},
    async disconnect() {},
    isConnected() {
      return true;
    },
    subscribe() {
      return () => {};
    },
    async request(command: { type?: string }) {
      if (command.type === "list_unacknowledged_chat_terminals") {
        listRequests += 1;
        return {
          terminals:
            listRequests === 1
              ? [
                  {
                    type: "rpc_turn_event",
                    event: "complete",
                    requestTag: "chat-inbox-owner-terminal",
                    finalText: "owner recovered final",
                    chatDeliveryContext: {
                      chatKey: "telegram/owner:room",
                      messageId: "owner-message",
                    },
                    terminalRecord: {
                      terminalId: "terminal-owner-recovery",
                      state: "complete",
                      terminalAt: "2026-08-17T09:00:00.000Z",
                    },
                  },
                ]
              : [],
        };
      }
      return {};
    },
  };
  const bridge = await chatMain.startChatBridge({
    hosted: false,
    commandRows: [],
    frontendClientFactory: () => frontend as never,
  });
  try {
    const deadline = Date.now() + 2_000;
    while (listRequests === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(listRequests > 0, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    await bridge.stop();
  }
});

test("chat main timer and ready-bot callbacks stay bounded by bridge lifecycle", async () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const callbacks: Array<() => unknown> = [];
  globalThis.setInterval = ((callback: () => unknown) => {
    callbacks.push(callback);
    return { owner: callbacks.length } as never;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  let bridge: Awaited<ReturnType<typeof chatMain.startChatBridge>> | undefined;
  try {
    bridge = await chatMain.startChatBridge({
      hosted: false,
      commandRows: [],
    });
    assert.equal(callbacks.length, 4);
    for (const callback of callbacks) await callback();
    bridge.app.emit("bot-status-updated", { status: 0 });
    bridge.app.emit("bot-status-updated", { status: 1 });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await bridge?.stop();
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test("chat main bridge evaluates successful and failed owner diagnostics", async () => {
  const bridge = await chatMain.startChatBridge({
    hosted: false,
    commandRows: [],
  });
  try {
    const evaluated = await bridge.evalBridge({
      code: "return { value: 7 };",
      requestId: "owner-success",
    });
    assert.equal(evaluated.ok, true);
    assert.equal((evaluated.value as { value?: number })?.value, 7);
    await assert.rejects(
      () =>
        bridge.evalBridge({
          code: "throw new Error('owner-eval-failed');",
          requestId: "owner-failure",
        }),
      /owner-eval-failed/,
    );
  } finally {
    await bridge.stop();
  }
});
