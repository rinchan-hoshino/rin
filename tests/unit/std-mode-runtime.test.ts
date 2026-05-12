import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const runtimeMod = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-lib", "runtime.js"))
    .href
);

function listen(server: http.Server) {
  return new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

test("Rin backend serializes web_search execution without tool-side metadata", async () => {
  const firstCanFinish = deferred();
  const firstStarted = deferred();
  const events: string[] = [];
  const baseTool = {
    name: "web_search",
    label: "Web Search",
    description: "Search or fetch web pages.",
    execute: async (toolCallId: string) => {
      events.push(`start:${toolCallId}`);
      if (toolCallId === "first") {
        firstStarted.resolve();
        await firstCanFinish.promise;
      }
      events.push(`end:${toolCallId}`);
      return { content: [], details: { toolCallId } };
    },
  };
  const session: any = {
    agent: { state: { tools: [baseTool] } },
    setActiveToolsByName(toolNames: string[]) {
      this.agent.state.tools = toolNames.includes("web_search")
        ? [baseTool]
        : [];
    },
    _refreshToolRegistry() {
      this.agent.state.tools = [baseTool];
    },
  };

  runtimeMod.applyRinBackendToolExecutionLocks(session);

  const lockedTool = session.agent.state.tools[0];
  assert.equal(lockedTool.executionMode, undefined);

  const first = lockedTool.execute("first");
  await firstStarted.promise;
  const second = lockedTool.execute("second");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, ["start:first"]);

  firstCanFinish.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, [
    "start:first",
    "end:first",
    "start:second",
    "end:second",
  ]);

  session.setActiveToolsByName(["web_search"]);
  assert.notEqual(session.agent.state.tools[0], baseTool);
  assert.equal(session.agent.state.tools[0].executionMode, undefined);
});

test("std configured session keeps daemon-independent Rin tools usable without daemon", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-std-runtime-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir, { recursive: true });

  const previousSocket = process.env.RIN_DAEMON_SOCKET_PATH;
  process.env.RIN_DAEMON_SOCKET_PATH = path.join(root, "missing-daemon.sock");

  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("std fetch ok");
  });
  await listen(server);

  const runtime = await runtimeMod.createConfiguredAgentSession({
    cwd: root,
    agentDir,
  });

  try {
    const session = runtime.session;
    for (const name of ["search_memory", "web_search"]) {
      assert.ok(session.getToolDefinition(name), `${name} should be available`);
    }
    assert.ok(
      session._customTools?.some((tool: any) => tool?.name === "web_search"),
      "Rin tools should enter the Pi session through SDK customTools",
    );
    assert.ok(
      !session.__rinCapabilities
        ?.getRegisteredCommands()
        ?.some((command: any) => command.invocationName === "init"),
      "self-improve init should be documentation-driven instead of a slash command",
    );

    const memoryResult = await session
      .getToolDefinition("search_memory")
      .execute("tool-memory", { limit: 1 }, undefined, undefined, {
        agentDir,
      });
    assert.match(memoryResult.content[0].text, /search_memory recent/);
    assert.equal(memoryResult.details.emptyMessage, "No memory results found.");

    const address = server.address();
    assert.equal(typeof address, "object");
    const fetchResult = await session
      .getToolDefinition("web_search")
      .execute(
        "tool-fetch",
        { q: `http://127.0.0.1:${address?.port}/demo` },
        undefined,
        undefined,
        { agentDir },
      );
    assert.match(fetchResult.content[0].text, /std fetch ok/);
    assert.equal(fetchResult.details.mode, "fetch");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("std search network unavailable");
    }) as typeof fetch;
    try {
      const searchResult = await session
        .getToolDefinition("web_search")
        .execute(
          "tool-search",
          { q: "rin std smoke", limit: 1 },
          undefined,
          undefined,
          { agentDir },
        );
      assert.match(searchResult.content[0].text, /web_search error/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await runtime.runtime?.dispose?.().catch?.(() => {});
    await closeServer(server).catch(() => {});
    if (previousSocket === undefined) {
      delete process.env.RIN_DAEMON_SOCKET_PATH;
    } else {
      process.env.RIN_DAEMON_SOCKET_PATH = previousSocket;
    }
  }
});

test("std configured session registration does not require daemon-only tools to connect", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-std-daemonless-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir, { recursive: true });

  const previousSocket = process.env.RIN_DAEMON_SOCKET_PATH;
  process.env.RIN_DAEMON_SOCKET_PATH = path.join(root, "missing-daemon.sock");

  const runtime = await runtimeMod.createConfiguredAgentSession({
    cwd: root,
    agentDir,
  });

  try {
    const session = runtime.session;
    for (const name of [
      "task_control",
      "fetch",
      "get_task",
      "save_task",
      "manage_task",
      "chat_bridge",
      "get_chat_msg",
      "list_chat_log",
      "save_chat_user_identity",
    ]) {
      assert.equal(
        session.getToolDefinition(name),
        undefined,
        `${name} should not register`,
      );
    }
  } finally {
    await runtime.runtime?.dispose?.().catch?.(() => {});
    if (previousSocket === undefined) {
      delete process.env.RIN_DAEMON_SOCKET_PATH;
    } else {
      process.env.RIN_DAEMON_SOCKET_PATH = previousSocket;
    }
  }
});
