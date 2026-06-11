import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const browseIndex = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-browse", "index.js"))
    .href
);

function getBrowseTool() {
  const tools = browseIndex.default().tools || [];
  const tool = tools.find((entry) => entry.name === "browse");
  assert.ok(tool);
  return tool;
}

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

test("browse fetches URLs with Chrome-like headers and Readability markdown", async () => {
  await withServer(
    (request, response) => {
      assert.match(request.headers["user-agent"] || "", /Chrome/);
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/page" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<html><head><title>Demo Title</title></head><body><main><h1>Readable</h1><p>Hello <b>Rin</b></p></main><nav>ignore</nav></body></html>",
      );
    },
    async (baseUrl) => {
      const tool = getBrowseTool();
      const result = await tool.execute(
        "tool-fetch",
        { q: `${baseUrl}/redirect` },
        undefined,
        undefined,
      );
      const agentText = String(result.content?.[0]?.text || "");
      const userText = String(result.details?.userText || "");

      assert.equal(result.details?.mode, "fetch");
      assert.equal(result.details?.fetch?.finalUrl, `${baseUrl}/page`);
      assert.match(agentText, /Browse fetch ok/);
      assert.match(agentText, /status=200 OK/);
      assert.match(userText, new RegExp(`Fetched: ${baseUrl}/page`));
      assert.match(userText, /Status: 200 OK/);
      assert.match(userText, /Title: Demo Title|Title: Readable/);
      assert.match(userText, /Hello \*\*Rin\*\*|Hello Rin/);
    },
  );
});
