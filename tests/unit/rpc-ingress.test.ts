import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const ingress = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "rpc-ingress.js"),
  ).href
);

test("RPC ingress accepts only object envelopes", () => {
  assert.equal(ingress.normalizeRinRpcInbound(null), null);
  assert.equal(ingress.normalizeRinRpcInbound([]), null);
  assert.deepEqual(ingress.normalizeRinRpcInbound({ type: "event" }), {
    type: "event",
  });
  assert.equal(
    ingress.isRinRpcResponse({ type: "response", id: "req_1", success: true }),
    true,
  );
  assert.equal(ingress.isRinRpcResponse({ type: "response", id: 1 }), false);
});

test("RPC response data rejects malformed and failed envelopes", () => {
  assert.deepEqual(
    ingress.readRinRpcResponseData({ success: true, data: { ok: true } }),
    { ok: true },
  );
  assert.throws(
    () => ingress.readRinRpcResponseData("bad"),
    /rin_request_failed/,
  );
  assert.throws(
    () => ingress.readRinRpcResponseData({ success: false, error: "denied" }),
    /denied/,
  );
});
