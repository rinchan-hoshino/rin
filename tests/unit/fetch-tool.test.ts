import test from "node:test";
import assert from "node:assert/strict";
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

test("fetch tool keeps agent and user response headers consistent", async () => {
  await withServer(
    (request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { location: "/page" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<html><head><title>Demo Title</title></head><body><main>Hello <b>Rin</b></main></body></html>",
      );
    },
    async (baseUrl) => {
      const tool = getFetchTool();
      const result = await tool.execute(
        "tool-fetch",
        { url: `${baseUrl}/redirect` },
        undefined,
        undefined,
      );
      const finalUrl = `${baseUrl}/page`;
      const agentText = String(result.content?.[0]?.text || "");
      const userText = String(result.details?.userText || "");

      assert.match(
        agentText,
        new RegExp(`^Fetched: ${escapeRegExp(finalUrl)}`, "m"),
      );
      assert.doesNotMatch(agentText, /^Final URL:/m);
      assert.match(
        userText,
        new RegExp(`^Final URL: ${escapeRegExp(finalUrl)}`, "m"),
      );
      assert.doesNotMatch(userText, /^Fetched:/m);
      assert.match(agentText, /Status: 200 OK/);
      assert.match(userText, /Status: 200 OK/);
      assert.match(agentText, /Title: Demo Title/);
      assert.match(userText, /Title: Demo Title/);
      assert.match(agentText, /Hello\s+Rin/);
      assert.match(userText, /Hello\s+Rin/);
    },
  );
});
