import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const fetchIndex = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "fetch", "index.js")).href
);

function getFetchTool() {
  const tools = fetchIndex.default().tools || [];
  const tool = tools.find((entry) => entry.name === "fetch");
  assert.ok(tool);
  return tool;
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("fetch tool pretty prints JSON responses", async () => {
  await withServer(
    (request, response) => {
      assert.equal(request.url, "/demo.json");
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end('{"hello":"world","count":1}');
    },
    async (baseUrl) => {
      const result = await getFetchTool().execute(
        "tool-fetch-json",
        { url: `${baseUrl}/demo.json` },
        undefined,
        undefined,
      );
      const text = String(result.content?.[0]?.text || "");
      assert.match(text, /Fetched: http:\/\/127\.0\.0\.1:\d+\/demo\.json/);
      assert.match(text, /MIME: application\/json/);
      assert.match(text, /\{\n {2}"hello": "world",\n {2}"count": 1\n\}/);
      assert.equal(result.details?.mimeType, "application/json");
      assert.equal(result.details?.truncation, undefined);
      assert.equal(result.details?.fullOutputPath, undefined);
    },
  );
});

test("fetch tool normalizes visible plain-text whitespace once", async () => {
  await withServer(
    (request, response) => {
      assert.equal(request.url, "/plain.txt");
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
      });
      response.end("alpha  \n   beta\t\n\n\n gamma");
    },
    async (baseUrl) => {
      const result = await getFetchTool().execute(
        "tool-fetch-plain-whitespace",
        { url: `${baseUrl}/plain.txt` },
        undefined,
        undefined,
      );
      const text = String(result.content?.[0]?.text || "");
      assert.match(text, /alpha\nbeta\n\ngamma/);
      assert.doesNotMatch(text, /alpha {2}\n/);
      assert.doesNotMatch(text, /\n {3}beta/);
      assert.equal(result.details?.mimeType, "text/plain");
    },
  );
});

test("fetch tool extracts HTML title and strips non-visible markup", async () => {
  await withServer(
    (request, response) => {
      assert.equal(request.url, "/demo.html");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
<html>
  <head>
    <title> Demo &amp; Test </title>
    <meta name="description" content="Head only metadata">
    <style>.hidden { display: none; }</style>
  </head>
  <body>
    <!-- hidden comment -->
    <div hidden>Hidden attr</div>
    <p aria-hidden="true">Hidden aria</p>
    <section style="display:none">Hidden style</section>
    <h1>Hello</h1>
    <script>console.log("secret")</script>
    <ul><li>One</li><li>Two</li></ul>
  </body>
</html>`);
    },
    async (baseUrl) => {
      const result = await getFetchTool().execute(
        "tool-fetch-html",
        { url: `${baseUrl}/demo.html` },
        undefined,
        undefined,
      );
      const text = String(result.content?.[0]?.text || "");
      assert.match(text, /Title: Demo & Test/);
      assert.equal(text.match(/Demo & Test/g)?.length ?? 0, 1);
      assert.match(text, /Hello/);
      assert.match(text, /- One/);
      assert.match(text, /- Two/);
      assert.doesNotMatch(text, /Head only metadata/);
      assert.doesNotMatch(text, /hidden comment/i);
      assert.doesNotMatch(text, /Hidden attr/);
      assert.doesNotMatch(text, /Hidden aria/);
      assert.doesNotMatch(text, /Hidden style/);
      assert.doesNotMatch(text, /console\.log/);
      assert.doesNotMatch(text, /display: none/);
      assert.equal(result.details?.title, "Demo & Test");
      assert.equal(result.details?.fullOutputPath, undefined);
    },
  );
});

test("fetch tool reads og:title regardless of meta attribute order", async () => {
  await withServer(
    (request, response) => {
      assert.equal(request.url, "/og-title.html");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
<html>
  <head>
    <meta content="OG &amp; Demo" property="og:title">
  </head>
  <body>
    <main>Visible body</main>
  </body>
</html>`);
    },
    async (baseUrl) => {
      const result = await getFetchTool().execute(
        "tool-fetch-og-title",
        { url: `${baseUrl}/og-title.html` },
        undefined,
        undefined,
      );
      const text = String(result.content?.[0]?.text || "");
      assert.match(text, /Title: OG & Demo/);
      assert.match(text, /Visible body/);
      assert.equal(result.details?.title, "OG & Demo");
    },
  );
});

test("fetch tool honors HTML meta charset declarations when the header omits one", async () => {
  await withServer(
    (request, response) => {
      assert.equal(request.url, "/meta-charset.html");
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        Buffer.from(
          `<!doctype html>
<html>
  <head>
    <meta content="text/html; charset=windows-1252" http-equiv="Content-Type">
    <title>caf\xe9</title>
  </head>
  <body>
    <p>Cr\xe8me br\xfbl\xe9e</p>
  </body>
</html>`,
          "latin1",
        ),
      );
    },
    async (baseUrl) => {
      const result = await getFetchTool().execute(
        "tool-fetch-meta-charset",
        { url: `${baseUrl}/meta-charset.html` },
        undefined,
        undefined,
      );
      const text = String(result.content?.[0]?.text || "");
      assert.match(text, /Title: café/);
      assert.match(text, /Crème brûlée/);
      assert.equal(result.details?.charset, "windows-1252");
      assert.equal(result.details?.title, "café");
    },
  );
});

test("fetch tool sniffs direct meta charset declarations even without a content-type header", async () => {
  await withServer(
    (request, response) => {
      assert.equal(request.url, "/meta-charset-sniff.html");
      response.writeHead(200);
      response.end(
        Buffer.from(
          `<!doctype html>
<html>
  <head>
    <meta charset="windows-1252">
    <title>pi\xf1ata</title>
  </head>
  <body>
    <p>jalape\xf1o</p>
  </body>
</html>`,
          "latin1",
        ),
      );
    },
    async (baseUrl) => {
      const result = await getFetchTool().execute(
        "tool-fetch-meta-charset-sniff",
        { url: `${baseUrl}/meta-charset-sniff.html` },
        undefined,
        undefined,
      );
      const text = String(result.content?.[0]?.text || "");
      assert.match(text, /Title: piñata/);
      assert.match(text, /jalapeño/);
      assert.equal(result.details?.charset, "windows-1252");
      assert.equal(result.details?.mimeType, "application/octet-stream");
      assert.equal(result.details?.title, "piñata");
    },
  );
});

test("fetch tool rejects non-text responses", async () => {
  await withServer(
    (request, response) => {
      assert.equal(request.url, "/file.bin");
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from([0x00, 0x01, 0x02, 0x03]));
    },
    async (baseUrl) => {
      await assert.rejects(
        () =>
          getFetchTool().execute(
            "tool-fetch-binary",
            { url: `${baseUrl}/file.bin` },
            undefined,
            undefined,
          ),
        /Fetch returned non-text content \(application\/octet-stream\)\./,
      );
    },
  );
});

test("fetch tool saves the full response to a preferred temp root when truncated", async () => {
  const previousTmpDir = process.env.TMPDIR;
  const previousRinTmpDir = process.env.RIN_TMP_DIR;
  const preferredRoot = await fs.mkdtemp(
    path.join("/home/rin/tmp", "rin-fetch-save-"),
  );
  let fullOutputPath;
  process.env.TMPDIR = "/path/that/does/not/exist";
  process.env.RIN_TMP_DIR = preferredRoot;
  try {
    await withServer(
      (request, response) => {
        assert.equal(request.url, "/huge.txt");
        response.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
        });
        response.end(
          Array.from({ length: 2200 }, (_, index) => `line ${index + 1}`).join(
            "\n",
          ),
        );
      },
      async (baseUrl) => {
        const result = await getFetchTool().execute(
          "tool-fetch-truncated",
          { url: `${baseUrl}/huge.txt` },
          undefined,
          undefined,
        );
        const text = String(result.content?.[0]?.text || "");
        assert.ok(result.details?.truncation?.truncated);
        assert.match(text, /\[Showing \d+ of \d+ lines\.\]/);
        assert.equal(typeof result.details?.fullOutputPath, "string");
        fullOutputPath = result.details?.fullOutputPath;
        assert.ok(fullOutputPath.startsWith(preferredRoot));
        const saved = await fs.readFile(fullOutputPath, "utf8");
        assert.match(saved, /Fetched: http:\/\/127\.0\.0\.1:\d+\/huge\.txt/);
        assert.match(saved, /line 2200/);
        assert.ok(!text.includes("line 2200"));
      },
    );
  } finally {
    process.env.TMPDIR = previousTmpDir;
    process.env.RIN_TMP_DIR = previousRinTmpDir;
    await fs.rm(preferredRoot, { recursive: true, force: true });
  }
});
