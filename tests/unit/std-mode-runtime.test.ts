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

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
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
    description:
      "Search the web, or fetch readable content from an HTTP(S) URL.",
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

test("configured session persists once a user starts a real conversation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-user-session-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir, { recursive: true });

  const runtime = await runtimeMod.createConfiguredAgentSession({
    cwd: root,
    agentDir,
  });

  try {
    const manager = runtime.session.sessionManager;
    const sessionFile = manager.getSessionFile();
    manager._rewriteFile();
    assert.equal(await pathExists(sessionFile), false);

    manager.appendMessage({ role: "user", content: "hello" });
    assert.equal(await pathExists(sessionFile), true);
  } finally {
    await runtime.runtime?.dispose?.().catch?.(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("configured sessions forward Pi tool startup options", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-tool-options-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir, { recursive: true });

  const runtime = await runtimeMod.createConfiguredAgentSession({
    cwd: root,
    agentDir,
    tools: ["read", "grep"],
    excludeTools: ["grep"],
    noTools: "builtin",
  });

  try {
    assert.deepEqual(runtime.session.getActiveToolNames(), ["read"]);
  } finally {
    await runtime.runtime?.dispose?.().catch?.(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("std configured session keeps daemon-independent Rin tools usable without daemon", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-std-runtime-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir, { recursive: true });

  const server = http.createServer((request, response) => {
    if (request.url?.startsWith("/search")) {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(JSON.stringify({ results: [] }));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("std fetch ok");
  });
  await listen(server);
  const address = server.address();
  assert.equal(typeof address, "object");
  const sidecarBaseUrl = `http://127.0.0.1:${address?.port}`;
  const sidecarStatePath = path.join(
    agentDir,
    "data",
    "sidecars",
    "web-search",
    "instances",
    `process-${process.pid}`,
    "state.json",
  );
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify({ extensions: ["rin:web-search"] })}\n`,
    "utf8",
  );
  await fs.mkdir(path.dirname(sidecarStatePath), { recursive: true });
  await fs.writeFile(
    sidecarStatePath,
    `${JSON.stringify({
      pid: process.pid,
      port: address?.port,
      baseUrl: sidecarBaseUrl,
      pythonBin: "/tmp/python",
      sourceDir: "/tmp/searxng",
      settingsPath: path.join(path.dirname(sidecarStatePath), "settings.yml"),
      startedAt: new Date().toISOString(),
      ownerPid: process.pid,
    })}\n`,
    "utf8",
  );

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
      runtime.runtime?.session?.resourceLoader
        ?.getExtensions?.()
        ?.extensions?.some((extension: any) =>
          extension.tools?.has?.("web_search"),
        ),
      "web_search should be provided by the built-in extension loader",
    );
    const memoryTool = session.getToolDefinition("search_memory");
    assert.equal(
      memoryTool.description,
      "Search archived session history by query, or browse recent sessions when query is omitted.",
    );
    assert.equal(
      memoryTool.promptSnippet,
      "Search archived session history for past-conversation evidence.",
    );
    assert.deepEqual(memoryTool.promptGuidelines, [
      "Use search_memory when past conversations, unfinished work, original wording, chronology, or cross-session continuity matters.",
    ]);
    assert.match(
      memoryTool.parameters.properties.query.description,
      /Session-memory search query/,
    );

    const memoryResult = await memoryTool.execute(
      "tool-memory",
      { limit: 1 },
      undefined,
      undefined,
      {
        agentDir,
      },
    );
    assert.match(memoryResult.content[0].text, /search_memory recent/);
    assert.equal(memoryResult.details.emptyMessage, "No memory results found.");

    const webTool = session.getToolDefinition("web_search");
    assert.equal(
      webTool.description,
      "Search the web, or fetch readable content from an HTTP(S) URL.",
    );
    assert.equal(
      webTool.promptSnippet,
      "Search the web or fetch readable content from a specific HTTP(S) page.",
    );
    assert.deepEqual(webTool.promptGuidelines, [
      "Use web_search when current, external, source-dependent, or version-sensitive web information matters.",
      "Use web_search URL mode when a specific HTTP(S) page is the evidence source.",
    ]);
    assert.match(
      webTool.parameters.properties.q.description,
      /Web search query or HTTP\(S\) URL/,
    );

    const fetchResult = await webTool.execute(
      "tool-fetch",
      { q: `http://127.0.0.1:${address?.port}/demo` },
      undefined,
      undefined,
      { agentDir },
    );
    assert.match(fetchResult.content[0].text, /std fetch ok/);
    assert.equal(fetchResult.details.mode, "fetch");

    const searchResult = await webTool.execute(
      "tool-search",
      { q: "rin std smoke", limit: 1 },
      undefined,
      undefined,
      { agentDir },
    );
    assert.equal(searchResult.isError, false);
    assert.match(searchResult.content[0].text, /web_search 0/);
  } finally {
    await runtime.runtime?.dispose?.().catch?.(() => {});
    await closeServer(server).catch(() => {});
  }
});

test("std configured session registration does not require daemon-only tools to connect", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-std-daemonless-"));
  const agentDir = path.join(root, "agent");
  await fs.mkdir(agentDir, { recursive: true });

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
  }
});
