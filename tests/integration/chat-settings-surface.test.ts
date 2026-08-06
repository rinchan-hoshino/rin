import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const support = await importBuiltModule<
  typeof import("../../src/core/chat/support.js")
>("dist/core/chat/support.js");

test("chat support ignores removed legacy adapter settings keys", () => {
  const config = support.buildChatConfigFromSettings({
    koishi: {
      telegram: { token: "legacy-token" },
    },
  });

  assert.equal(config.plugins["adapter-telegram"], undefined);
});
