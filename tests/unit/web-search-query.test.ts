import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
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

beforeEach(() => {
  query.resetWebSearchRuntimeStateForTests?.({
    googleMinIntervalMs: 0,
    googleMaxIntervalMs: 0,
  });
});

const googleFixture = `
<div>
  <a href="/url?q=https://github.com/rinchanai/rin&sa=U&ved=demo" data-ved="demo">
    <div style="-webkit-line-clamp:2">GitHub - rinchanai/rin</div>
  </a>
  <div class="VwiC3b yXK7lf p4wth r025kc hJNv6b">Rin personal workspace mirror managed by <b>RinChan</b>.</div>
</div>`;

const googleGsaFixture = `
<div>
  <div class="Gx5Zad xpd EtOod pkphOe">
    <div class="egMi0 kCrYT">
      <a href="/url?q=https://example.com/google-result&amp;sa=U&amp;ved=2ahUKEwi-demo&amp;usg=demo" data-ved="2ahUKEwi-demo">
        <div class="DnJfK">
          <div class="j039Wc"><h3 class="zBAuLc l97dzf"><div class="ilUpNd UFvD1 aSRlid IwSnJ" style="-webkit-line-clamp:2">SearXNG style Google result</div></h3></div>
          <div class="sCuL3"><div class="ilUpNd BamJPe aSRlid XR4uSe">example.com</div></div>
        </div>
      </a>
    </div>
    <div class="kCrYT"><div><div class="ilUpNd H66NU aSRlid"><span class="UK5aid MDvRSc">3 days ago</span><span class="UK5aid MDvRSc"> · </span>Snippet from the Google Go rendered result card.</div></div></div>
  </div>
</div>`;

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
      "https://www.example.com/docs",
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
    language: "  zh-CN  ",
  });
  assert.equal(req.q, "demo");
  assert.equal(req.language, "zh-CN");
  assert.equal(req.freshness, undefined);
});

test("web search maps freshness to direct provider query parameters", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "<html><body>No results</body></html>",
    };
  }) as typeof fetch;
  try {
    const result = await query.searchWeb({ q: "rinchanai", freshness: "week" });
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 0);
    assert.equal(result.error, undefined);
    assert.equal(calls.length, 1);
    const googleUrl = new URL(calls[0]);
    assert.equal(googleUrl.searchParams.get("tbs"), "qdr:w");
    assert.equal(googleUrl.searchParams.has("num"), false);
    assert.equal(googleUrl.searchParams.has("gl"), false);
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

test("google parser extracts direct results", () => {
  const rows = query.parseGoogleResults(googleFixture, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].engine, "google");
  assert.equal(rows[0].url, "https://github.com/rinchanai/rin");
  assert.equal(rows[0].title, "GitHub - rinchanai/rin");
  assert.equal(
    rows[0].snippet,
    "Rin personal workspace mirror managed by RinChan.",
  );
  assert.equal(rows[0].domain, "github.com");
});

test("web search service reports direct provider runtime status", () => {
  const status = service.getWebSearchStatus("/tmp/rin-agent");
  assert.equal(status.runtime.ready, true);
  assert.equal(status.runtime.mode, "direct");
  assert.equal(status.runtime.providerCount, 1);
  assert.deepEqual(status.runtime.providers, ["google"]);
  assert.deepEqual(status.instances, []);
});

test("web search uses google direct results only", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => googleFixture,
    };
  }) as typeof fetch;
  try {
    const result = await query.searchWeb({ q: "rinchanai", limit: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "google");
    assert.equal(result.results.length, 1);
    assert.deepEqual(
      result.results.map((item: any) => item.engine),
      ["google"],
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(result.attempts, [
      { engine: "google", ok: true, results: 1 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search requests Google with SearXNG-style mobile user agent", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init.headers });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => googleGsaFixture,
    };
  }) as typeof fetch;
  try {
    const result = await query.searchWeb({ q: "rinchanai", limit: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "google");
    assert.equal(result.results[0].url, "https://example.com/google-result");
    assert.equal(calls.length, 1);
    const googleUrl = new URL(calls[0].url);
    assert.equal(googleUrl.hostname, "www.google.com");
    assert.equal(googleUrl.searchParams.get("hl"), "en-US");
    assert.equal(googleUrl.searchParams.has("lr"), false);
    assert.equal(googleUrl.searchParams.has("cr"), false);
    assert.equal(googleUrl.searchParams.has("num"), false);
    assert.equal(googleUrl.searchParams.has("gl"), false);
    assert.match(calls[0].headers["User-Agent"], /NSTNWV$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search localizes Google with SearXNG-style domain and country params", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init.headers });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => googleGsaFixture,
    };
  }) as typeof fetch;
  try {
    const result = await query.searchWeb({
      q: "rinchanai",
      limit: 1,
      language: "zh-CN",
    });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "google");
    const googleUrl = new URL(calls[0].url);
    assert.equal(googleUrl.hostname, "www.google.com.hk");
    assert.equal(googleUrl.searchParams.get("hl"), "zh-CN");
    assert.equal(googleUrl.searchParams.get("lr"), "lang_zh-CN");
    assert.equal(googleUrl.searchParams.get("cr"), "countryCN");
    assert.equal(calls[0].headers.Referer, "https://www.google.com.hk/");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search treats empty Google result pages as empty results", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => "<html><body>No Google results</body></html>",
    };
  }) as typeof fetch;
  try {
    const result = await query.searchWeb({ q: "rinchanai", limit: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "google");
    assert.equal(result.results.length, 0);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.attempts, [
      { engine: "google", ok: true, results: 0 },
    ]);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search spaces Google requests when configured", async () => {
  query.resetWebSearchRuntimeStateForTests?.({
    googleMinIntervalMs: 5,
    googleMaxIntervalMs: 5,
  });
  const originalFetch = globalThis.fetch;
  const starts: number[] = [];
  globalThis.fetch = (async () => {
    starts.push(Date.now());
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => googleFixture,
    };
  }) as typeof fetch;
  try {
    await Promise.all([
      query.searchWeb({ q: "rinchanai one", limit: 1 }),
      query.searchWeb({ q: "rinchanai two", limit: 1 }),
    ]);
    assert.equal(starts.length, 2);
    assert.ok(starts[1] - starts[0] >= 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search reports failure when google is challenged", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () =>
      "<html><body><h1>CAPTCHA</h1><p>automated queries detected</p></body></html>",
  })) as typeof fetch;
  try {
    const result = await query.searchWeb({ q: "rinchanai", limit: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.engine, "google");
    assert.deepEqual(result.attempts, [
      { engine: "google", ok: false, error: "google_challenge_required" },
    ]);
    assert.equal(result.results.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search provider attempts expose fetch failure details", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const cause = Object.assign(new Error("Connect Timeout Error"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const error = new TypeError("fetch failed") as TypeError & {
      cause?: unknown;
    };
    error.cause = cause;
    throw error;
  }) as typeof fetch;
  try {
    const result = await query.searchWeb({ q: "rinchanai", limit: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.attempts?.length, 1);
    assert.match(result.attempts?.[0].error || "", /fetch_failed/);
    assert.match(result.attempts?.[0].error || "", /www\.google\.com\/search/);
    assert.match(result.attempts?.[0].error || "", /UND_ERR_CONNECT_TIMEOUT/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search tool output omits provider attempts and raw markers on failure", async () => {
  const originalFetch = globalThis.fetch;
  const registeredTool = webSearchIndex
    .default()
    .tools.find((tool: any) => tool.name === "web_search");

  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const result = await registeredTool.execute("call-demo", {
      q: "rinchanai",
      limit: 1,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Web search failed/);
    assert.match(result.content[0].text, /network request failed/i);
    assert.doesNotMatch(result.content[0].text, /attempts:/);
    assert.doesNotMatch(result.content[0].text, /fetch_failed/);
    assert.equal(result.details.attempts, undefined);
    assert.match(result.details.userText, /network request failed/i);
    assert.doesNotMatch(result.details.userText, /attempts:/);
    assert.doesNotMatch(result.details.userText, /fetch_failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search tool output humanizes challenge markers", async () => {
  const originalFetch = globalThis.fetch;
  const registeredTool = webSearchIndex
    .default()
    .tools.find((tool: any) => tool.name === "web_search");

  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () =>
      "<html><body><h1>CAPTCHA</h1><p>automated queries detected</p></body></html>",
  })) as typeof fetch;
  try {
    const result = await registeredTool.execute("call-demo", {
      q: "rinchanai",
      limit: 1,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Google blocked this search path/);
    assert.match(result.details.userText, /Google blocked this search path/);
    assert.doesNotMatch(result.content[0].text, /google_challenge_required/);
    assert.doesNotMatch(result.details.userText, /google_challenge_required/);
    assert.doesNotMatch(result.content[0].text, /attempts:/);
    assert.doesNotMatch(result.details.userText, /attempts:/);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
