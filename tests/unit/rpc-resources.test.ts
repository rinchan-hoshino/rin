import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const resources = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-lib", "rpc-resources.js"),
  ).href
);

test("RPC resource snapshots normalize valid arrays and malformed sections", () => {
  assert.deepEqual(
    resources.normalizeRpcResourceSnapshot({
      skills: { skills: [{ name: "demo" }], diagnostics: "invalid" },
      prompts: null,
      themes: { themes: ["night"], diagnostics: [] },
      extensions: {
        extensions: [{ path: "/demo.ts" }],
        errors: null,
        diagnostics: [],
        commandDiagnostics: [{ message: "conflict" }],
        shortcutDiagnostics: "invalid",
      },
    }),
    {
      skills: { skills: [{ name: "demo" }], diagnostics: [] },
      prompts: { prompts: [], diagnostics: [] },
      themes: { themes: ["night"], diagnostics: [] },
      extensions: {
        extensions: [{ path: "/demo.ts" }],
        errors: [],
        diagnostics: [],
        commandDiagnostics: [{ message: "conflict" }],
        shortcutDiagnostics: [],
      },
    },
  );
});

test("empty RPC resource snapshots do not share mutable arrays", () => {
  const first = resources.emptyRpcResourceSnapshot();
  const second = resources.emptyRpcResourceSnapshot();
  first.skills.skills.push({ name: "demo" });
  assert.deepEqual(second.skills.skills, []);
});
