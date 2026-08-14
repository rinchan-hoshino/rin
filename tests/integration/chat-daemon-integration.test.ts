import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createChatDaemonIntegration } from "../../dist/core/chat/daemon-integration.js";
import { saveChatMessage } from "../../dist/core/chat/message-store.js";

function createBridgeFixture(calls: Array<[string, unknown]>) {
  const call = async (name: string, payload: unknown) => {
    calls.push([name, payload]);
    return { name, payload };
  };
  return {
    send: (payload: unknown) => call("send", payload),
    runTurn: (payload: unknown) => call("runTurn", payload),
    typing: (payload: unknown) => call("typing", payload),
    react: (payload: unknown) => call("react", payload),
    terminateTurn: (payload: unknown) => call("terminateTurn", payload),
    evalBridge: (payload: unknown) => call("evalBridge", payload),
  };
}

test("Chat daemon integration owns delivery and every chat RPC command", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-daemon-integration-"),
  );
  const calls: Array<[string, unknown]> = [];
  const bridge = createBridgeFixture(calls);
  const integration = createChatDaemonIntegration({
    agentDir,
    getBridge: async () => bridge as any,
  });

  try {
    const payload = { owner: true };
    assert.deepEqual(await integration.delivery.send(payload as any), {
      name: "send",
      payload,
    });
    assert.deepEqual(await integration.delivery.runTurn(payload as any), {
      name: "runTurn",
      payload,
    });
    assert.deepEqual(await integration.delivery.typing(payload), {
      name: "typing",
      payload,
    });
    assert.deepEqual(await integration.delivery.react(payload), {
      name: "react",
      payload,
    });
    assert.deepEqual(await integration.delivery.terminateTurn(payload), {
      name: "terminateTurn",
      payload,
    });

    const routed = [];
    for (const type of [
      "chat_send",
      "chat_run_turn",
      "chat_typing",
      "chat_react",
      "chat_terminate_turn",
      "chat_bridge_eval",
    ]) {
      routed.push(
        await integration.commandRouter({ type, payload }),
        await integration.commandRouter({ type }),
      );
    }
    routed.push(
      await integration.commandRouter({
        type: "chat_message_get",
        payload: { chatKey: "discord/bot:room", messageId: "missing" },
      }),
      await integration.commandRouter({ type: "chat_message_get" }),
      await integration.commandRouter({
        type: "chat_message_list",
        payload: { chatKey: "discord/bot:room", limit: 10 },
      }),
      await integration.commandRouter({ type: "chat_message_list" }),
    );

    assert.equal(routed.length, 16);
    for (const result of routed) assert.equal(result?.success, true);
    assert.equal(routed[12]?.data, null);
    assert.equal(routed[13]?.data, null);
    assert.deepEqual(routed[14]?.data, []);
    assert.deepEqual(routed[15]?.data, []);

    saveChatMessage(agentDir, {
      messageId: "stored",
      chatKey: "discord/bot:room",
      platform: "discord",
      chatId: "room",
      receivedAt: "2026-08-14T00:00:00.000Z",
      text: "owner message",
    });
    const stored = await integration.commandRouter({
      type: "chat_message_get",
      payload: { chatKey: "discord/bot:room", messageId: "stored" },
    });
    assert.equal((stored?.data as any)?.text, "owner message");
    const listed = await integration.commandRouter({
      type: "chat_message_list",
      payload: { chatKey: "discord/bot:room", limit: 10 },
    });
    assert.equal((listed?.data as any[])?.length, 1);

    assert.equal(
      await integration.commandRouter({ type: "owner_extension_command" }),
      undefined,
    );
    assert.equal(await integration.commandRouter({}), undefined);
    for (const malformed of [null, "chat_send", []]) {
      assert.equal(await integration.commandRouter(malformed), undefined);
    }

    assert.deepEqual(
      calls.map(([name]) => name),
      [
        "send",
        "runTurn",
        "typing",
        "react",
        "terminateTurn",
        "send",
        "send",
        "runTurn",
        "runTurn",
        "typing",
        "typing",
        "react",
        "react",
        "terminateTurn",
        "terminateTurn",
        "evalBridge",
        "evalBridge",
      ],
    );
    assert.deepEqual(calls[6], ["send", {}]);
    assert.deepEqual(calls.at(-1), ["evalBridge", {}]);
    assert.equal(typeof integration.extensionApi.listKeys, "function");
    assert.equal(
      typeof integration.extensionApi.getSessionBindings,
      "function",
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
