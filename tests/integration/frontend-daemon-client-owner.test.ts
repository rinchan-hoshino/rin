import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const daemonClient = await importBuiltModule<
  typeof import("../../src/core/rin-frontend-sdk/daemon-client.js")
>("dist/core/rin-frontend-sdk/daemon-client.js");

type Request = Record<string, any>;

type TestServer = {
  socketPath: string;
  requests: Request[];
  sockets: Set<net.Socket>;
  close(): Promise<void>;
};

async function createRpcServer(
  respond: (request: Request, socket: net.Socket) => void,
): Promise<TestServer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-frontend-client-"));
  const socketPath = path.join(dir, "daemon.sock");
  const requests: Request[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const request = JSON.parse(line);
        requests.push(request);
        respond(request, socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    socketPath,
    requests,
    sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

function response(socket: net.Socket, request: Request, data: unknown) {
  socket.write(
    `${JSON.stringify({
      type: "response",
      id: request.id,
      command: request.type,
      success: true,
      data,
    })}\n`,
  );
}

test("frontend daemon client owns the complete RPC command surface", async () => {
  let heldCompact: { request: Request; socket: net.Socket } | undefined;
  const server = await createRpcServer((request, socket) => {
    if (request.type === "compact" && !heldCompact) {
      heldCompact = { request, socket };
      return;
    }
    const payloads: Record<string, unknown> = {
      prompt: { finalText: "done" },
      abort: { aborted: true },
      get_commands: {
        commands: [
          {
            name: "/owner",
            description: "Owner command",
            category: "Rin",
            source: "extension",
          },
          { id: "fallback-id", name: "fallback" },
        ],
      },
      get_command_argument_completions: {
        items: [
          { id: "one", label: "One", value: "one", description: "first" },
          { value: "two" },
          null,
        ],
      },
      get_state: { sessionFile: "/sessions/active.jsonl" },
      get_messages: { messages: [{ role: "assistant", content: "done" }] },
      run_command: { handled: true, text: "command done" },
      shutdown_session: { stopped: true },
      terminate_session: { terminated: true },
      new_session: { sessionFile: "/sessions/new.jsonl" },
      set_model: { provider: request.provider, modelId: request.modelId },
      set_thinking_level: { level: request.level },
      reset_model_options_from_settings: { reset: true },
      extension_ui_response: { accepted: true },
      list_sessions: {
        sessions: [
          { id: "old", path: "/sessions/old.jsonl", name: "Old" },
          { id: "active", path: "/sessions/active.jsonl", name: "Active" },
        ],
      },
      select_session: { selected: request.sessionPath },
      get_available_models: {
        models: [
          {
            id: "model-a",
            label: "Model A",
            provider: "demo",
            description: "Owner model",
          },
          { id: "model-b" },
        ],
      },
    };
    response(socket, request, payloads[request.type] ?? {});
  });
  const client = new daemonClient.RinDaemonFrontendClient({
    socketPath: server.socketPath,
    connectTimeoutMs: 500,
    frontendIdentity: { kind: "chat", key: "discord/1:2" },
  });

  try {
    assert.equal(client.isConnected(), false);
    const disconnectedCommands = await client.getCommands();
    assert.ok(disconnectedCommands.length > 0);
    assert.ok(
      disconnectedCommands.every(
        (item) => item.id && item.name && item.description,
      ),
    );
    assert.deepEqual(await client.listSessions(), []);
    assert.deepEqual(await client.listModels(), []);

    await Promise.all([client.connect(), client.connect()]);
    assert.equal(client.isConnected(), true);
    await client.connect();

    assert.deepEqual(await client.submit("hello"), { finalText: "done" });
    assert.deepEqual(await client.prompt("owner", { requestTag: "tag-1" }), {
      finalText: "done",
    });
    await client.abort();

    assert.deepEqual(await client.getCommands(), [
      {
        id: "/owner",
        name: "/owner",
        description: "Owner command",
        category: "Rin",
        source: "extension",
        chat: false,
      },
      {
        id: "fallback",
        name: "fallback",
        description: undefined,
        category: undefined,
        source: undefined,
        chat: false,
      },
    ]);
    assert.deepEqual(await client.getCommandArgumentCompletions("owner", "t"), [
      {
        id: "one",
        label: "One",
        insertText: "one",
        detail: "first",
        kind: "other",
      },
      {
        id: "two",
        label: "two",
        insertText: "two",
        detail: undefined,
        kind: "other",
      },
      {
        id: "2",
        label: "",
        insertText: undefined,
        detail: undefined,
        kind: "other",
      },
    ]);
    assert.deepEqual(await client.getAutocompleteItems("/owner t"), [
      {
        id: "one",
        label: "One",
        insertText: "one",
        detail: "first",
        kind: "other",
      },
      {
        id: "two",
        label: "two",
        insertText: "two",
        detail: undefined,
        kind: "other",
      },
      {
        id: "2",
        label: "",
        insertText: undefined,
        detail: undefined,
        kind: "other",
      },
    ]);
    assert.equal((await client.getAutocompleteItems("owner")).length, 2);
    assert.deepEqual(await client.getState(), {
      sessionFile: "/sessions/active.jsonl",
    });
    assert.deepEqual(await client.getMessages(), [
      { role: "assistant", content: "done" },
    ]);
    assert.deepEqual(await client.runCommand("/owner"), {
      handled: true,
      text: "command done",
    });

    const compact = client.compact("summarize", {
      sessionFile: "/sessions/active.jsonl",
    });
    assert.deepEqual(await client.compact(), {
      handled: true,
      compactionBusy: true,
      text: "Compaction already in progress.",
    });
    for (let attempt = 0; attempt < 20 && !heldCompact; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(heldCompact);
    response(heldCompact.socket, heldCompact.request, { compacted: true });
    assert.deepEqual(await compact, { compacted: true });

    assert.deepEqual(await client.shutdownSession(), { stopped: true });
    assert.deepEqual(await client.terminateSession(), { terminated: true });
    assert.deepEqual(
      await client.newSession({
        frontendIdentity: { kind: "tui", key: "terminal" },
        sessionName: "owner",
      }),
      { sessionFile: "/sessions/new.jsonl" },
    );
    assert.deepEqual(
      await client.newSession({ sessionName: "default-owner" }),
      {
        sessionFile: "/sessions/new.jsonl",
      },
    );
    assert.deepEqual(
      await client.setModel("demo", "model-a", { persistSettings: false }),
      { provider: "demo", modelId: "model-a" },
    );
    assert.deepEqual(await client.setModel("demo", "model-b"), {
      provider: "demo",
      modelId: "model-b",
    });
    assert.deepEqual(
      await client.setThinkingLevel("high", { persistSettings: false }),
      { level: "high" },
    );
    assert.deepEqual(await client.setThinkingLevel("medium"), {
      level: "medium",
    });
    assert.deepEqual(await client.resetModelOptionsFromSettings(), {
      reset: true,
    });
    await client.respondExtensionUi({
      type: "extension_ui_response",
      id: "ui-1",
      value: true,
    } as any);

    const sessions = await client.listSessions();
    assert.equal(sessions.length, 2);
    assert.equal(
      sessions.find((item) => item.isActive)?.id,
      "/sessions/active.jsonl",
    );
    await client.resumeSession("/sessions/old.jsonl");
    await client.resumeSession("/sessions/active.jsonl", {
      frontendIdentity: { kind: "tui", key: "terminal" },
    });
    assert.deepEqual(await client.listModels(), [
      {
        id: "model-a",
        label: "Model A",
        provider: "demo",
        description: "Owner model",
      },
      {
        id: "model-b",
        label: "model-b",
        provider: undefined,
        description: undefined,
      },
    ]);
    assert.equal(await client.openDialog("unused"), null);
    await client.respondDialog("unused", {});

    const prompts = server.requests.filter((item) => item.type === "prompt");
    assert.equal(prompts[0].message, "hello");
    assert.deepEqual(prompts[0].frontendIdentity, {
      kind: "chat",
      key: "discord/1:2",
    });
    assert.equal(prompts[1].requestTag, "tag-1");
    const compactRequest = server.requests.find(
      (item) => item.type === "compact",
    );
    assert.equal(compactRequest.customInstructions, "summarize");
    assert.equal(compactRequest.sessionFile, "/sessions/active.jsonl");
  } finally {
    await client.disconnect();
    assert.equal(client.isConnected(), false);
    await client.disconnect();
    await server.close();
  }
});

test("frontend daemon client maps unsolicited daemon events", async () => {
  const server = await createRpcServer((request, socket) =>
    response(socket, request, {}),
  );
  const client = new daemonClient.RinDaemonFrontendClient(server.socketPath);
  const seen: any[] = [];
  const unsubscribe = client.subscribe((event) => seen.push(event));
  client.subscribe(() => {
    throw new Error("listener failure must remain isolated");
  });

  try {
    await client.connect();
    assert.deepEqual(await client.prompt("without identity"), {});
    assert.deepEqual(await client.shutdownSession(), {});
    assert.deepEqual(await client.terminateSession(), {});
    assert.deepEqual(await client.newSession(), {});
    await client.resumeSession("/sessions/plain.jsonl");
    assert.deepEqual(await client.getMessages(), []);
    assert.deepEqual(
      await client.getCommandArgumentCompletions("owner", ""),
      [],
    );
    assert.deepEqual(await client.getAutocompleteItems("/owner"), []);
    assert.deepEqual(await client.compact(), {});
    assert.deepEqual(await client.listSessions(), []);
    assert.deepEqual(await client.listModels(), []);

    const socket = [...server.sockets][0];
    socket.write("not-json\nnull\n");
    socket.write(
      [
        { type: "stderr", line: "warning" },
        { type: "stderr" },
        { type: "worker_exit", workerId: "worker-1" },
        { type: "extension_ui_request", id: "ui-1", method: "confirm" },
        { type: "extension_error", error: "broken" },
        { type: "response", id: "unknown", success: true },
        { type: "custom_event", value: 1 },
        {},
      ]
        .map((item) => JSON.stringify(item))
        .join("\n") + "\n",
    );
    for (let attempt = 0; attempt < 20 && seen.length < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(
      seen.map((event) => event.type),
      [
        "status",
        "status",
        "ui",
        "extension_ui_request",
        "extension_error",
        "ui",
        "ui",
        "ui",
      ],
    );
    assert.deepEqual(seen[0], {
      type: "status",
      level: "warning",
      text: "warning",
    });
    assert.equal(seen[1].text, "");
    assert.equal(seen[2].name, "worker_exit");
    assert.equal(seen[5].name, "response");
    assert.equal(seen[6].name, "custom_event");
    assert.equal(seen[7].name, "event");
    unsubscribe();

    socket.destroy();
    for (let attempt = 0; attempt < 20 && client.isConnected(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(client.isConnected(), false);
  } finally {
    await client.disconnect();
    await server.close();
  }
});

test("frontend daemon client rejects failed responses and preserves pending work on explicit disconnect", async () => {
  const server = await createRpcServer((request, socket) => {
    if (request.type === "pending") return;
    socket.write(
      `${JSON.stringify({
        type: "response",
        id: request.id,
        command: request.type,
        success: false,
        error: request.type === "explicit_error" ? "owner failure" : "",
      })}\n`,
    );
  });
  const client = new daemonClient.RinDaemonFrontendClient({
    socketPath: server.socketPath,
    connectSocket: () => net.createConnection(server.socketPath),
    connectTimeoutMs: -1,
  });
  const events: any[] = [];
  client.subscribe((event) => events.push(event));

  try {
    await client.connect();
    await assert.rejects(
      client.request({ type: "explicit_error" } as any),
      /owner failure/,
    );
    await assert.rejects(
      client.request({ type: "empty_error" } as any),
      /rin_request_failed/,
    );
    const pending = client.send({ type: "pending" } as any);
    await new Promise((resolve) => setImmediate(resolve));
    await client.disconnect();
    assert.equal(client.pending.size, 1);
    assert.equal(
      await Promise.race([
        pending.then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<string>((resolve) =>
          setImmediate(() => resolve("pending")),
        ),
      ]),
      "pending",
    );
    for (const entry of client.pending.values()) clearTimeout(entry.timer);
    client.pending.clear();
    assert.equal(events.at(-1), undefined);
  } finally {
    await client.disconnect();
    await server.close();
  }
});

test("frontend daemon client identifies pending work when its transport disconnects", async () => {
  let pendingSocket: net.Socket | undefined;
  const server = await createRpcServer((request, socket) => {
    if (request.type === "get_state") pendingSocket = socket;
  });
  const client = new daemonClient.RinDaemonFrontendClient({
    socketPath: server.socketPath,
    connectSocket: () => net.createConnection(server.socketPath),
  });
  const events: any[] = [];
  client.subscribe((event) => events.push(event));

  try {
    await client.connect();
    const pending = client.send({ type: "get_state" });
    for (let attempt = 0; attempt < 20 && !pendingSocket; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(pendingSocket);
    pendingSocket.destroy();

    await assert.rejects(pending, /^Error: rin_disconnected:get_state:req_1$/);
    for (let attempt = 0; attempt < 20 && client.isConnected(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(client.pending.size, 0);
    assert.equal(client.isConnected(), false);
    assert.deepEqual(
      events.map((event) => [event.type, event.name]),
      [["ui", "connection_lost"]],
    );
  } finally {
    await client.disconnect();
    await server.close();
  }
});

test("frontend daemon client reports connector failures and connect timeouts", async () => {
  const rejected = new daemonClient.RinDaemonFrontendClient({
    socketPath: "/unused.sock",
    connectSocket: async () => {
      throw "connector rejected";
    },
    connectTimeoutMs: 50,
  });
  await assert.rejects(rejected.connect(), /connector rejected/);
  assert.equal(rejected.connectPromise, null);

  class NeverConnectSocket extends EventEmitter {
    destroyed = false;
    write() {
      return true;
    }
    end() {}
    destroy() {
      this.destroyed = true;
    }
  }
  const socket = new NeverConnectSocket();
  const timedOut = new daemonClient.RinDaemonFrontendClient({
    socketPath: "/unused.sock",
    connectSocket: () => socket as any,
    connectTimeoutMs: 10,
  });
  await assert.rejects(timedOut.connect(), /rin_timeout:connect/);
  assert.equal(socket.destroyed, true);
  await assert.rejects(
    timedOut.send({ type: "status" } as any),
    /rin_tui_not_connected/,
  );
});
