import assert from "node:assert/strict";
import test from "node:test";
import {
  defineRinDaemonExtension,
  defineRinExtension,
} from "../../dist/core/rin-extension-api.js";

test("Rin extension API definition helpers preserve factory identity", () => {
  const foreground = () => undefined;
  const daemon = async () => undefined;

  assert.equal(defineRinExtension(foreground), foreground);
  assert.equal(defineRinDaemonExtension(daemon), daemon);
});
