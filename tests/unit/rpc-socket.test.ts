import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const sockets = await importBuiltModule<
  typeof import("../../src/core/platform/rpc-socket.js")
>("dist/core/platform/rpc-socket.js");

function onceEvent(socket: NodeJS.EventEmitter, event: string) {
  return new Promise<unknown[]>((resolve) => {
    socket.once(event, (...args: unknown[]) => resolve(args));
  });
}

test("in-memory rpc sockets connect and deliver data asynchronously", async () => {
  const { clientSocket, serverSocket } = sockets.createConnectedRpcSocketPair();
  const clientConnected = onceEvent(clientSocket, "connect");
  const serverConnected = onceEvent(serverSocket, "connect");
  await Promise.all([clientConnected, serverConnected]);

  const received = onceEvent(serverSocket, "data");
  assert.equal(clientSocket.write("hello\n"), true);
  assert.deepEqual(await received, ["hello\n"]);

  const reply = onceEvent(clientSocket, "data");
  assert.equal(serverSocket.write("world\n"), true);
  assert.deepEqual(await reply, ["world\n"]);
});

test("ending either rpc socket closes the pair once and rejects later writes", async () => {
  const { clientSocket, serverSocket } = sockets.createConnectedRpcSocketPair();
  let clientCloses = 0;
  let serverCloses = 0;
  clientSocket.on("close", () => {
    clientCloses += 1;
  });
  serverSocket.on("close", () => {
    serverCloses += 1;
  });
  const clientClosed = onceEvent(clientSocket, "close");
  const serverClosed = onceEvent(serverSocket, "close");

  clientSocket.end();
  clientSocket.end();
  clientSocket.destroy();
  await Promise.all([clientClosed, serverClosed]);

  assert.equal(clientSocket.destroyed, true);
  assert.equal(serverSocket.destroyed, true);
  assert.equal(clientCloses, 1);
  assert.equal(serverCloses, 1);
  assert.equal(clientSocket.write("late"), false);
  assert.equal(serverSocket.write("late"), false);
});

test("destroying an rpc socket reports its error locally and closes its peer cleanly", async () => {
  const { clientSocket, serverSocket } = sockets.createConnectedRpcSocketPair();
  const errors: Error[] = [];
  clientSocket.on("error", (error) => errors.push(error));
  let serverErrors = 0;
  serverSocket.on("error", () => {
    serverErrors += 1;
  });
  const clientClosed = new Promise<void>((resolve) => {
    clientSocket.once("close", resolve);
  });
  const serverClosed = new Promise<void>((resolve) => {
    serverSocket.once("close", resolve);
  });

  clientSocket.destroy(new Error("transport failed"));
  await Promise.all([clientClosed, serverClosed]);

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.message, "transport failed");
  assert.equal(serverErrors, 0);
});

test("queued rpc socket delivery is suppressed when the peer closes first", async () => {
  const { clientSocket, serverSocket } = sockets.createConnectedRpcSocketPair();
  let received = 0;
  serverSocket.on("data", () => {
    received += 1;
  });
  const clientClosed = onceEvent(clientSocket, "close");
  const serverClosed = onceEvent(serverSocket, "close");

  assert.equal(clientSocket.write("queued"), true);
  serverSocket.destroy();
  await Promise.all([clientClosed, serverClosed]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(received, 0);
  assert.equal(clientSocket.write("after-close"), false);
});
