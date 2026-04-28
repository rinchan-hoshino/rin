import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const responseUtils = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "fetch", "response-utils.js"),
  ).href
);

test("fetch response utils normalize supported URLs", () => {
  assert.equal(
    responseUtils.normalizeUrl(" https://example.com/demo?q=1 "),
    "https://example.com/demo?q=1",
  );
  assert.throws(
    () => responseUtils.normalizeUrl("ftp://example.com/file.txt"),
    /Unsupported URL protocol: ftp:/,
  );
  assert.throws(
    () => responseUtils.normalizeUrl("   "),
    /Invalid URL: \(empty\)/,
  );
});

test("fetch response utils parse content-type values consistently", () => {
  assert.deepEqual(
    responseUtils.parseContentType(' Application/JSON ; Charset = "utf-8" '),
    {
      mimeType: "application/json",
      charset: "utf-8",
    },
  );
  assert.deepEqual(
    responseUtils.parseContentType(
      "text/html; boundary=something; charset=windows-1252",
    ),
    {
      mimeType: "text/html",
      charset: "windows-1252",
    },
  );
  assert.deepEqual(responseUtils.parseContentType(null), {
    mimeType: "application/octet-stream",
    charset: undefined,
  });
});

test("fetch response utils detect text-like mime types after normalization", () => {
  assert.equal(responseUtils.isTextLike(" text/plain "), true);
  assert.equal(responseUtils.isTextLike("Application/Json"), true);
  assert.equal(responseUtils.isTextLike("application/xml"), true);
  assert.equal(responseUtils.isTextLike("application/javascript"), true);
  assert.equal(responseUtils.isTextLike("image/svg+xml"), true);
  assert.equal(
    responseUtils.isTextLike("application/x-www-form-urlencoded"),
    true,
  );
  assert.equal(responseUtils.isTextLike("application/octet-stream"), false);
});
