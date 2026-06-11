import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
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

test("browse URL mode pretty prints JSON responses", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, nested: { value: 1 } }));
    },
    async (baseUrl) => {
      const result = await getBrowseTool().execute(
        "tool-fetch-json",
        { q: `${baseUrl}/data` },
        undefined,
        undefined,
      );
      assert.equal(result.details?.mode, "fetch");
      assert.match(String(result.content?.[0]?.text || ""), /"nested": \{/);
    },
  );
});

test("browse URL mode extracts HTML as markdown by default and text on request", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        "<html><head><title>Article</title></head><body><article><h1>Article</h1><p>Hello <strong>Rin</strong></p></article></body></html>",
      );
    },
    async (baseUrl) => {
      const tool = getBrowseTool();
      const markdown = await tool.execute(
        "tool-fetch-html-markdown",
        { q: `${baseUrl}/article` },
        undefined,
        undefined,
      );
      const text = await tool.execute(
        "tool-fetch-html-text",
        { q: `${baseUrl}/article`, format: "text" },
        undefined,
        undefined,
      );
      assert.match(
        String(markdown.details?.userText || ""),
        /Hello \*\*Rin\*\*/,
      );
      assert.match(String(text.details?.userText || ""), /Hello Rin/);
      assert.doesNotMatch(String(text.details?.userText || ""), /\*\*Rin\*\*/);
    },
  );
});

test("browse URL mode reports non-text content as a fetch error", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    },
    async (baseUrl) => {
      const result = await getBrowseTool().execute(
        "tool-fetch-binary",
        { q: `${baseUrl}/image.png` },
        undefined,
        undefined,
      );
      assert.equal(result.isError, true);
      assert.match(
        String(result.content?.[0]?.text || ""),
        /Unsupported content type: image\/png/,
      );
    },
  );
});
