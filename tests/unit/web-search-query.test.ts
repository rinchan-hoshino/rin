import test from "node:test";
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

const duckDuckGoLiteFixture = `
<table>
  <tr>
    <td>1.&nbsp;</td>
    <td>
      <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Frinchanai%2Frin&amp;rut=abc" class='result-link'>GitHub - rinchanai/rin</a>
    </td>
  </tr>
  <tr>
    <td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'>Rin personal workspace mirror managed by <b>RinChan</b>.</td>
  </tr>
</table>`;

const openAiDocsDuckDuckGoLiteFixture = `
<table>
  <tr>
    <td>1.&nbsp;</td>
    <td>
      <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fplatform.openai.com%2Fdocs%2Fguides%2Fprompt-caching&amp;rut=abc" class='result-link'>OpenAI Platform</a>
    </td>
  </tr>
  <tr>
    <td>&nbsp;&nbsp;&nbsp;</td>
    <td class='result-snippet'>Prompt caching documentation for OpenAI API requests.</td>
  </tr>
</table>`;

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

test("duckduckgo lite parser extracts direct results", () => {
  const rows = query.parseDuckDuckGoLiteResults(duckDuckGoLiteFixture, 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].engine, "duckduckgo");
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
  assert.equal(status.runtime.providerCount, 2);
  assert.deepEqual(status.runtime.providers, ["google", "duckduckgo"]);
  assert.deepEqual(status.instances, []);
});

test("web search uses google results first and fills gaps from duckduckgo", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [googleFixture, openAiDocsDuckDuckGoLiteFixture];
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => responses.shift() || "",
  })) as typeof fetch;
  try {
    const result = await query.searchWeb({ q: "rinchanai", limit: 2 });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "google");
    assert.equal(result.results.length, 2);
    assert.deepEqual(
      result.results.map((item: any) => [item.engine, item.url]),
      [
        ["google", "https://github.com/rinchanai/rin"],
        [
          "duckduckgo",
          "https://platform.openai.com/docs/guides/prompt-caching",
        ],
      ],
    );
    assert.deepEqual(
      result.attempts?.map((item: any) => [
        item.engine,
        item.ok,
        item.results ?? 0,
      ]),
      [
        ["google", true, 1],
        ["duckduckgo", true, 1],
      ],
    );
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
    assert.equal(new URL(calls[0].url).hostname, "www.google.com");
    assert.match(calls[0].headers["User-Agent"], /NSTNWV$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("duckduckgo provider uses the lite endpoint directly", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const responses = [
    "<html><body>No Google results</body></html>",
    "<html><body>No Google results again</body></html>",
    duckDuckGoLiteFixture,
  ];
  globalThis.fetch = (async (url: any) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => responses.shift() || "",
    };
  }) as typeof fetch;
  try {
    const result = await query.searchWeb({ q: "rinchanai", limit: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "duckduckgo");
    assert.equal(result.results[0].url, "https://github.com/rinchanai/rin");
    assert.equal(
      calls.some((url) => url.includes("html.duckduckgo.com")),
      false,
    );
    assert.equal(
      calls.some((url) => url.includes("lite.duckduckgo.com")),
      true,
    );
    assert.deepEqual(result.attempts, [
      { engine: "google", ok: true, results: 0 },
      { engine: "duckduckgo", ok: true, results: 1 },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search tries duckduckgo when google has no results", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    "<html><body>No Google results</body></html>",
    "<html><body>No Google results again</body></html>",
    openAiDocsDuckDuckGoLiteFixture,
  ];
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => responses.shift() || "",
  })) as typeof fetch;
  try {
    const result = await query.searchWeb({
      q: "OpenAI API prompt caching prompt_cache_key retention cache evicted idle 5 10 minutes",
      limit: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "duckduckgo");
    assert.deepEqual(result.attempts, [
      { engine: "google", ok: true, results: 0 },
      { engine: "duckduckgo", ok: true, results: 1 },
    ]);
    assert.equal(
      result.results[0].url,
      "https://platform.openai.com/docs/guides/prompt-caching",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search applies embedded site operators after provider search", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    "<html><body>No Google results</body></html>",
    "<html><body>No Google results again</body></html>",
    openAiDocsDuckDuckGoLiteFixture,
  ];
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => responses.shift() || "",
  })) as typeof fetch;
  try {
    const result = await query.searchWeb({
      q: "site:platform.openai.com/docs prompt caching prompt_cache_key cache retention",
      limit: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "duckduckgo");
    assert.deepEqual(result.attempts, [
      { engine: "google", ok: true, results: 0 },
      { engine: "duckduckgo", ok: true, results: 1 },
    ]);
    assert.equal(result.results[0].domain, "platform.openai.com");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search retries google once before falling back", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    "<html><body>No Google results yet</body></html>",
    googleFixture,
  ];
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => responses.shift() || "",
  })) as typeof fetch;
  try {
    const result = await query.searchWeb({ q: "rinchanai", limit: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.engine, "google");
    assert.deepEqual(result.attempts, [
      { engine: "google", ok: true, results: 1 },
    ]);
    assert.equal(result.results[0].url, "https://github.com/rinchanai/rin");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web search reports failure when google is challenged and duckduckgo is empty", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    "<html><body><h1>CAPTCHA</h1><p>automated queries detected</p></body></html>",
    "<html><body>No DuckDuckGo results</body></html>",
  ];
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => responses.shift() || "",
  })) as typeof fetch;
  try {
    const result = await query.searchWeb({ q: "rinchanai", limit: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.engine, "google");
    assert.deepEqual(result.attempts, [
      { engine: "google", ok: false, error: "google_challenge_required" },
      { engine: "duckduckgo", ok: true, results: 0 },
    ]);
    assert.equal(result.results.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
