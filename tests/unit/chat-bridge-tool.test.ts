import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const chatBridgeModule = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "chat-bridge.js"))
    .href
);

test("chat_bridge only forwards valid current chat session names", async () => {
  const runtimeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-bridge-runtime-"),
  );
  const socketDir = path.join(runtimeDir, "rin-daemon");
  const socketPath = path.join(socketDir, "daemon.sock");
  await fs.mkdir(socketDir, { recursive: true });

  const requests = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        requests.push(payload);
        socket.write(
          `${JSON.stringify({
            type: "response",
            id: payload.id,
            command: payload.type,
            success: true,
            data: {
              text: "ok",
              durationMs: 5,
            },
          })}\n`,
        );
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  const tools = chatBridgeModule.default().tools || [];
  const chatBridgeTool = tools.find((tool) => tool.name === "chat_bridge");
  assert.ok(chatBridgeTool);
  assert.match(
    chatBridgeTool.promptGuidelines?.join("\n") || "",
    /sending rich chat content/,
  );
  assert.match(
    chatBridgeTool.parameters?.properties?.code?.description || "",
    /can send rich chat content/,
  );
  assert.doesNotMatch(
    chatBridgeTool.parameters?.properties?.code?.description || "",
    /helpers\.send/,
  );
  assert.doesNotMatch(
    chatBridgeTool.parameters?.properties?.code?.description || "",
    /\{ type: "image"/,
  );

  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  const previousSocketPath = process.env.RIN_DAEMON_SOCKET_PATH;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.RIN_DAEMON_SOCKET_PATH = socketPath;
  try {
    await chatBridgeTool.execute(
      "bridge-invalid",
      { code: "return 'ok';" },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionName: () => "telegram:1",
          getSessionId: () => undefined,
          getSessionFile: () => undefined,
        },
      },
    );
    await chatBridgeTool.execute(
      "bridge-valid",
      { code: "return 'ok';" },
      undefined,
      undefined,
      {
        sessionManager: {
          getSessionName: () => "telegram/777:1",
          getSessionId: () => undefined,
          getSessionFile: () => undefined,
        },
      },
    );

    assert.equal(requests.length, 2);
    assert.equal(requests[0].type, "chat_bridge_eval");
    assert.equal(requests[0].payload?.currentChatKey, undefined);
    assert.equal(requests[1].payload?.currentChatKey, "telegram/777:1");
  } finally {
    process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    process.env.RIN_DAEMON_SOCKET_PATH = previousSocketPath;
    await new Promise((resolve) => server.close(() => resolve()));
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
});
