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
const query = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-web-search", "query.js"),
  ).href
);
const paths = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-web-search", "paths.js"),
  ).href
);
const service = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-web-search", "service.js"),
  ).href
);
const webSearchIndex = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-web-search", "index.js"),
  ).href
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

async function writeLiveSidecarState(agentDir: string, baseUrl: string) {
  const instanceId = `process-${process.pid}`;
  const statePath = path.join(
    agentDir,
    "data",
    "web-search",
    "instances",
    instanceId,
    "state.json",
  );
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    `${JSON.stringify({
      pid: process.pid,
      port: Number(new URL(baseUrl).port || 0),
      baseUrl,
      pythonBin: "/tmp/python",
      sourceDir: "/tmp/searxng",
      settingsPath: path.join(path.dirname(statePath), "settings.yml"),
      startedAt: new Date().toISOString(),
      ownerPid: process.pid,
    })}\n`,
    "utf8",
  );
}

async function withMockManagedSidecar(
  handler: http.RequestListener,
  fn: (agentDir: string, baseUrl: string) => Promise<void>,
) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-web-search-"));
  const server = http.createServer(handler);
  await listen(server);
  const address = server.address();
  assert.equal(typeof address, "object");
  const baseUrl = `http://127.0.0.1:${address?.port}`;
  await writeLiveSidecarState(agentDir, baseUrl);
  try {
    await fn(agentDir, baseUrl);
  } finally {
    await closeServer(server).catch(() => {});
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

function jsonResponse(response: http.ServerResponse, value: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

test("web search query helpers normalize request", () => {
  const req = query.normalizeSearchRequest({
    q: "  hello ",
    limit: 99,
    domains: ["a.com", "a.com", "b.com"],
  });
  assert.equal(req.q, "hello");
  assert.equal(req.limit, 8);
  assert.deepEqual(req.domains, ["a.com", "b.com"]);
  assert.equal(query.buildSearchQuery(req), "hello site:a.com site:b.com");
});

test("web search query helpers normalize domain filters", () => {
  const req = query.normalizeSearchRequest({
    q: "docs",
    domains: [
      '"https://www.example.com/docs"',
      "example.com/docs",
      "site:*.example.org/blog",
    ],
  });
  assert.deepEqual(req.domains, ["example.com/docs", "example.org/blog"]);
  assert.equal(
    query.buildSearchQuery(req),
    "docs site:example.com/docs site:example.org/blog",
  );
});

test("web search query helpers discard invalid freshness", () => {
  const req = query.normalizeSearchRequest({
    q: " demo ",
    freshness: "decade",
    language: "  zh_CN  ",
  });
  assert.equal(req.q, "demo");
  assert.equal(req.language, "zh-CN");
  assert.equal(req.freshness, undefined);
});

test("web search query helpers normalize locale-style language hints", () => {
  assert.equal(
    query.normalizeSearchRequest({ q: "demo", language: "en_US" }).language,
    "en-US",
  );
  assert.equal(
    query.normalizeSearchRequest({ q: "demo", language: "zh-hans_cn" })
      .language,
    "zh-hans-CN",
  );
});

test("web search maps freshness to SearXNG sidecar query parameters", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          results: [
            {
              title: "Rin result",
              url: "https://example.com/rin",
              content: "from searxng",
              engine: "google",
            },
          ],
        }),
    };
  }) as typeof fetch;
  try {
    const result = await query.searchWeb("http://127.0.0.1:8080", {
      q: "rinchanai",
      freshness: "week",
    });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "google");
    assert.equal(result.results[0].url, "https://example.com/rin");
    assert.equal(calls.length, 1);
    const searxngUrl = new URL(calls[0]);
    assert.equal(searxngUrl.origin, "http://127.0.0.1:8080");
    assert.equal(searxngUrl.pathname, "/search");
    assert.equal(searxngUrl.searchParams.get("format"), "json");
    assert.equal(searxngUrl.searchParams.get("engines"), "google");
    assert.equal(searxngUrl.searchParams.get("safesearch"), "0");
    assert.equal(searxngUrl.searchParams.get("time_range"), "week");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search falls back across SearXNG engines", async () => {
  const originalFetch = globalThis.fetch;
  const engines: string[] = [];
  globalThis.fetch = (async (url: any) => {
    const target = new URL(String(url));
    const engine = target.searchParams.get("engines") || "";
    engines.push(engine);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        JSON.stringify({
          results:
            engine === "bing"
              ? [
                  {
                    title: "Bing result",
                    url: "https://example.com/bing",
                    content: "fallback result",
                    engine,
                  },
                ]
              : [],
        }),
    };
  }) as typeof fetch;
  try {
    const result = await query.searchWeb("http://127.0.0.1:8080", {
      q: "rinchanai",
      limit: 2,
    });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "bing");
    assert.equal(result.results[0].url, "https://example.com/bing");
    assert.deepEqual(engines, ["google", "bing"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search paths derive data root location", () => {
  const root = "/tmp/demo";
  assert.ok(
    paths.dataRootForState(root).endsWith(path.join("data", "web-search")),
  );
});

test("web search service reports SearXNG sidecar runtime status by default", () => {
  const status = service.getWebSearchStatus("/tmp/rin-agent");
  assert.equal(status.runtime.ready, false);
  assert.equal(status.runtime.mode, "searxng-sidecar");
  assert.equal(status.runtime.providerCount, 3);
  assert.deepEqual(status.runtime.providers, ["google", "bing", "duckduckgo"]);
  assert.deepEqual(status.instances, []);
});

test("web search status does not install or start SearXNG", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-web-search-"));
  try {
    const status = service.getWebSearchStatus(agentDir);
    assert.equal(status.runtime.ready, false);
    assert.deepEqual(status.instances, []);
    await assert.rejects(
      () => fs.stat(path.join(agentDir, "data", "web-search", "runtime")),
      /ENOENT/,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("web search runtime rejects an invalid managed Python before source install", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-web-search-"));
  const uvPath = paths.runtimeUvBinForState(agentDir);
  await fs.mkdir(path.dirname(uvPath), { recursive: true });
  await fs.writeFile(
    uvPath,
    [
      "#!/bin/sh",
      'PY="$UV_PYTHON_INSTALL_DIR/cpython-3.9/bin/python"',
      'if [ "$1 $2" = "python install" ]; then DIR="${PY%/*}"; /bin/mkdir -p "$DIR"; printf "%s\\n" "#!/bin/sh" "echo 3.9.6" > "$PY"; /bin/chmod +x "$PY"; exit 0; fi',
      'if [ "$1 $2" = "python find" ]; then echo "$PY"; exit 0; fi',
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(uvPath, 0o755);
  try {
    await assert.rejects(
      () => service.prepareSearxngRuntime(agentDir),
      /python_version_unsupported/,
    );
    await assert.rejects(
      () =>
        fs.stat(
          path.join(agentDir, "data", "web-search", "runtime", "searxng"),
        ),
      /ENOENT/,
    );
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("web search runtime installs Rin-managed Python with private uv before source install", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "rin-web-search-"));
  const uvPath = paths.runtimeUvBinForState(agentDir);
  await fs.mkdir(path.dirname(uvPath), { recursive: true });
  await fs.writeFile(
    uvPath,
    [
      "#!/bin/sh",
      'PY="$UV_PYTHON_INSTALL_DIR/cpython-3.12/bin/python"',
      'if [ "$1 $2" = "python install" ]; then DIR="${PY%/*}"; /bin/mkdir -p "$DIR"; printf "%s\\n" "#!/bin/sh" "echo 3.12.4" > "$PY"; /bin/chmod +x "$PY"; exit 0; fi',
      'if [ "$1 $2" = "python find" ]; then echo "$PY"; exit 0; fi',
      "exit 1",
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(uvPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(
      () => service.prepareSearxngRuntime(agentDir),
      /web_search_runtime_fetch_tools_not_found/,
    );
    await fs.stat(
      path.join(
        agentDir,
        "data",
        "runtime",
        "python",
        "cpython-3.12",
        "bin",
        "python",
      ),
    );
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(agentDir, { recursive: true, force: true });
  }
});

test("web search service reuses Rin-managed sidecar state", async () => {
  await withMockManagedSidecar(
    (request, response) => {
      assert.ok(request.url?.startsWith("/search"));
      const target = new URL(request.url || "/", "http://127.0.0.1");
      assert.equal(target.searchParams.get("engines"), "google");
      jsonResponse(response, {
        results: [
          {
            title: "SearXNG result",
            url: "https://example.com/result",
            content: "from local sidecar",
            engine: "google",
          },
        ],
      });
    },
    async (agentDir) => {
      const result = await service.searchWeb(
        { q: "rinchanai", limit: 2 },
        { stateRoot: agentDir },
      );
      assert.equal(result.ok, true);
      assert.equal(result.engine, "google");
      assert.equal(result.results[0].url, "https://example.com/result");
      assert.deepEqual(result.attempts, [
        { engine: "google", ok: true, results: 1 },
      ]);
    },
  );
});

test("web search tool output exposes provider attempts to the agent on sidecar failure", async () => {
  const registeredTool = webSearchIndex
    .default()
    .tools.find((tool: any) => tool.name === "web_search");

  await withMockManagedSidecar(
    (_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("sidecar unavailable");
    },
    async (agentDir) => {
      const result = await registeredTool.execute(
        "call-demo",
        {
          q: "rinchanai",
          limit: 1,
        },
        undefined,
        undefined,
        { agentDir },
      );
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Web search failed/);
      assert.match(result.content[0].text, /network request failed/i);
      assert.match(result.content[0].text, /attempts:/);
      assert.match(result.content[0].text, /fetch_failed/);
      assert.equal(result.details.attempts.length, 3);
      assert.match(result.details.userText, /network request failed/i);
      assert.doesNotMatch(result.details.userText, /attempts:/);
      assert.doesNotMatch(result.details.userText, /fetch_failed/);
    },
  );
});

test("web search tool exposes SearXNG parameter errors for agent retry", async () => {
  const registeredTool = webSearchIndex
    .default()
    .tools.find((tool: any) => tool.name === "web_search");

  await withMockManagedSidecar(
    (_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":"Invalid value zh_CN for parameter language"}');
    },
    async (agentDir) => {
      const result = await registeredTool.execute(
        "call-demo",
        {
          q: "rinchanai",
          limit: 1,
          language: "bad_language",
        },
        undefined,
        undefined,
        { agentDir },
      );
      assert.equal(result.isError, true);
      assert.match(
        result.content[0].text,
        /Invalid value zh_CN for parameter language/,
      );
      assert.match(result.content[0].text, /attempts:/);
      assert.match(result.content[0].text, /language=zh_CN/);
      assert.equal(result.details.attempts.length, 3);
      assert.match(
        result.details.userText,
        /invalid search parameter language=zh_CN/,
      );
      assert.doesNotMatch(result.details.userText, /fetch_failed/);
    },
  );
});

test("web search maps zh_CN language hints to SearXNG-compatible zh-CN", async () => {
  await withMockManagedSidecar(
    (request, response) => {
      const target = new URL(request.url || "/", "http://127.0.0.1");
      assert.equal(target.searchParams.get("language"), "zh-CN");
      jsonResponse(response, {
        results: [
          {
            title: "Chinese result",
            url: "https://example.com/zh",
            content: "from local sidecar",
            engine: "google",
          },
        ],
      });
    },
    async (agentDir) => {
      const result = await service.searchWeb(
        { q: "hangzhou weather", limit: 1, language: "zh_CN" },
        { stateRoot: agentDir },
      );
      assert.equal(result.ok, true);
      assert.equal(result.results[0].url, "https://example.com/zh");
    },
  );
});

test("web search URL call label omits fetch prefix", () => {
  const registeredTool = webSearchIndex
    .default()
    .tools.find((tool: any) => tool.name === "web_search");
  const rendered = registeredTool
    .renderCall(
      { q: "https://example.com/page" },
      {
        fg: (_kind: string, text: string) => text,
        bold: (text: string) => text,
      },
    )
    .render(100)
    .join("\n");
  assert.match(rendered, /https:\/\/example\.com\/page/);
  assert.doesNotMatch(rendered, /fetch https:/);
});

test("web search tool definition does not request tool-side sequential execution", () => {
  const registeredTool = webSearchIndex
    .default()
    .tools.find((tool: any) => tool.name === "web_search");
  assert.equal(registeredTool.executionMode, undefined);
});
