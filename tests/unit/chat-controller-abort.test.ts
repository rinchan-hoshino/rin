import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { installChatControllerSessionClient } from "../support/chat-controller-session-client.js";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const { ChatController } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "controller.js"))
    .href
);

async function createController(chatKey = "telegram/1:2") {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-controller-abort-"),
  );
  const dataDir = path.join(tempDir, "data");
  await fs.mkdir(dataDir, { recursive: true });
  const controller = new ChatController({}, dataDir, chatKey, {
    logger: { info() {}, warn() {} },
    h: {
      text(content: string) {
        return { type: "text", attrs: { content } };
      },
      quote(id: string) {
        return { type: "quote", attrs: { id } };
      },
    },
  });
  installChatControllerSessionClient(controller.constructor);
  controller.app = {
    bots: [
      {
        platform: "telegram",
        selfId: "1",
        async sendMessage() {
          return ["m1"];
        },
        async createReaction() {},
        async deleteReaction() {},
        internal: {
          async sendChatAction() {},
        },
      },
    ],
  };
  controller.connect = async () => {};
  return controller;
}

function emitRpcTurnComplete(
  controller: any,
  requestTag: string,
  finalText: string,
) {
  controller.handleClientEvent({
    type: "ui",
    payload: {
      type: "rpc_turn_event",
      event: "complete",
      requestTag,
      finalText,
      result: {
        messages: [{ type: "text", text: finalText }],
      },
      sessionId: controller.session?.sessionManager?.getSessionId?.(),
      sessionFile: controller.session?.sessionManager?.getSessionFile?.(),
    },
  });
}

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deliveryText(delivery: any) {
  return (delivery?.parts || [])
    .map((part: any) =>
      part?.type === "text" || part?.type === "markdown" ? part.text : "",
    )
    .filter(Boolean)
    .join("\n");
}
