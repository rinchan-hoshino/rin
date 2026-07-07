import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createChatOutboxDeliveryPendingError,
  isChatOutboxDeliveryPendingError,
  resolveChatOutboxDeliveryPendingState,
} from "../../src/core/chat/delivery-errors.js";
import { writeChatOutboxItem } from "../../src/core/rin-lib/chat-outbox.js";

function outboxItem(agentDir: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "outbox-1",
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sequence: Date.now(),
    deliveryKind: "final",
    payload: {
      type: "text_delivery",
      createdAt: new Date().toISOString(),
      chatKey: "telegram/1:2",
      text: "hello",
    },
    attempts: 1,
    lastError: "chat_outbox_delivery_pending",
    ...overrides,
  } as any;
}

test("chat outbox pending delivery errors carry an outbox id", () => {
  const error = createChatOutboxDeliveryPendingError("outbox-1");
  assert.equal(isChatOutboxDeliveryPendingError(error), true);
  assert.equal(error.outboxId, "outbox-1");
  assert.equal(error.message, "chat_outbox_delivery_pending");
});

test("chat outbox pending state is based on the current outbox item", async () => {
  const agentDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-delivery-errors-"),
  );
  try {
    const error = createChatOutboxDeliveryPendingError("outbox-1");

    assert.equal(resolveChatOutboxDeliveryPendingState(agentDir, error), null);

    writeChatOutboxItem(agentDir, outboxItem(agentDir));
    assert.equal(
      resolveChatOutboxDeliveryPendingState(agentDir, error),
      "pending",
    );

    writeChatOutboxItem(
      agentDir,
      outboxItem(agentDir, {
        status: "delivered",
        deliveredAt: new Date().toISOString(),
        deliveryResult: ["message-1"],
        lastError: undefined,
      }),
    );
    assert.equal(
      resolveChatOutboxDeliveryPendingState(agentDir, error),
      "delivered",
    );

    const failedError = createChatOutboxDeliveryPendingError("outbox-failed");
    writeChatOutboxItem(
      agentDir,
      outboxItem(agentDir, {
        id: "outbox-failed",
        status: "failed",
        failedAt: new Date().toISOString(),
        lastError: "forbidden",
      }),
    );
    assert.equal(
      resolveChatOutboxDeliveryPendingState(agentDir, failedError),
      null,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});
