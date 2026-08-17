import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { importBuiltModule } from "../support/import-built-module.js";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const { createRinHttpTransport, discardRinHttpResponseBody } =
  await importBuiltModule<typeof import("../../src/core/http/transport.js")>(
    "dist/core/http/transport.js",
  );

async function withServer(
  handler: Parameters<typeof createServer>[0],
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("Rin HTTP transport does not use process-global fetch", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("isolated");
    },
    async (baseUrl) => {
      const originalFetch = globalThis.fetch;
      const transport = createRinHttpTransport();
      try {
        globalThis.fetch = async () => {
          throw new Error("process_global_fetch_used");
        };
        const response = await transport.fetch(baseUrl);
        assert.equal(await response.text(), "isolated");
      } finally {
        globalThis.fetch = originalFetch;
        await transport.close();
      }
    },
  );
});

test("Rin HTTP transport reconstructs cross-realm multipart bodies", async () => {
  let captured: { contentType: string; body: Buffer } | undefined;
  await withServer(
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        captured = {
          contentType: String(request.headers["content-type"] || ""),
          body: Buffer.concat(chunks),
        };
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      });
    },
    async (baseUrl) => {
      const transport = createRinHttpTransport({
        reconstructFormData: true,
      });
      try {
        const foreignUndici = await import(
          pathToFileURL(
            path.join(
              rootDir,
              "node_modules",
              "@discordjs",
              "rest",
              "node_modules",
              "undici",
              "index.js",
            ),
          ).href
        );
        const form = new foreignUndici.FormData();
        assert.equal(form instanceof FormData, false);
        form.append("payload_json", '{"content":"test"}');
        form.append(
          "files[0]",
          new foreignUndici.File(
            [Buffer.from([0, 1, 2, 255])],
            " original.png ",
            { type: "image/png" },
          ),
        );
        const response = await transport.fetch(baseUrl, {
          method: "POST",
          headers: { "content-type": "multipart/form-data; boundary=stale" },
          body: form,
        });
        assert.deepEqual(await response.json(), { ok: true });
      } finally {
        await transport.close();
      }
    },
  );

  assert.match(captured?.contentType || "", /^multipart\/form-data; boundary=/);
  assert.equal(captured?.contentType.includes("boundary=stale"), false);
  const body = captured?.body || Buffer.alloc(0);
  assert.match(body.toString("latin1"), /name="payload_json"/);
  assert.match(body.toString("latin1"), /filename=" original.png "/);
  assert.match(body.toString("latin1"), /Content-Type: image\/png/);
  assert.ok(body.includes(Buffer.from([0, 1, 2, 255])));
});

test("Rin HTTP transport discards response bodies without surfacing cleanup errors", async () => {
  let cancels = 0;
  await discardRinHttpResponseBody({
    body: {
      async cancel() {
        cancels += 1;
      },
    },
  });
  await discardRinHttpResponseBody({
    body: {
      async cancel() {
        throw new Error("already closed");
      },
    },
  });
  await discardRinHttpResponseBody(undefined);
  assert.equal(cancels, 1);
});

test("Rin HTTP transport owns dispatcher cleanup", async () => {
  let closes = 0;
  const transport = createRinHttpTransport({
    dispatcher: {
      async close() {
        closes += 1;
      },
    } as any,
  });

  await transport.close();
  await transport.close();
  assert.equal(closes, 1);
});
