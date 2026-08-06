import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const toolOptions = await importBuiltModule<
  typeof import("../../src/core/rin-lib/tool-options.js")
>("dist/core/rin-lib/tool-options.js");

test("tool options parse and deduplicate comma-separated names", () => {
  assert.deepEqual(toolOptions.parseRinToolNameList(null), []);
  assert.deepEqual(toolOptions.parseRinToolNameList(" read, bash ,,read "), [
    "read",
    "bash",
    "read",
  ]);
  assert.deepEqual(
    toolOptions.normalizeRinToolStartupOptions({
      tools: ["read,bash", "read", "custom"],
      excludeTools: ["bash", " bash , edit "],
      noTools: "builtin",
    }),
    {
      tools: ["read", "bash", "custom"],
      excludeTools: ["bash", "edit"],
      noTools: "builtin",
    },
  );
});

test("tool options preserve explicit empty selections and reject unknown modes", () => {
  assert.deepEqual(toolOptions.normalizeRinToolStartupOptions(undefined), {});
  assert.deepEqual(
    toolOptions.normalizeRinToolStartupOptions({
      tools: [],
      excludeTools: undefined,
      noTools: "invalid" as any,
    }),
    { tools: [] },
  );
  assert.equal(toolOptions.hasRinToolStartupOptions(undefined), false);
  assert.equal(toolOptions.hasRinToolStartupOptions({ tools: [] }), true);
  assert.equal(
    toolOptions.hasRinToolStartupOptions({ excludeTools: ["read"] }),
    true,
  );
  assert.equal(toolOptions.hasRinToolStartupOptions({ noTools: "all" }), true);
  assert.deepEqual(toolOptions.serializeRinToolStartupOptions(undefined), {});
  assert.deepEqual(toolOptions.serializeRinToolStartupOptions({ tools: [] }), {
    tools: [],
  });
});

test("tool options resolve explicit, excluded, and disabled active names", () => {
  assert.deepEqual(
    toolOptions.resolveRinActiveToolNames(["read", "custom", "custom"], {
      tools: ["write", "custom", "bash"],
      excludeTools: ["bash"],
    }),
    ["write", "custom"],
  );
  assert.deepEqual(
    toolOptions.resolveRinActiveToolNames("read,bash,edit,write,custom", {
      noTools: "builtin",
    }),
    ["custom"],
  );
  assert.deepEqual(
    toolOptions.resolveRinActiveToolNames(["read", "custom"], {
      noTools: "all",
    }),
    [],
  );
  assert.deepEqual(
    toolOptions.resolveRinActiveToolNames(["read", "custom"], {
      excludeTools: ["read"],
    }),
    ["custom"],
  );
});
