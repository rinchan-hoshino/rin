import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const chatMain = await importBuiltModule<
  typeof import("../../src/core/chat/main.js")
>("dist/core/chat/main.js");

test("chat main startup cleans up when command-catalog construction fails", async () => {
  await assert.rejects(
    () =>
      chatMain.startChatBridge({
        hosted: false,
        frontendClientFactory() {
          throw new Error("catalog unavailable");
        },
      }),
    /catalog unavailable/,
  );
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
