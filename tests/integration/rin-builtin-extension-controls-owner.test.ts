import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const registerFixture = path.resolve(
  "tests/support/register-built-in-controls-owner-fixture.ts",
);

const childScript = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

globalThis.__rinBuiltInOwnerEvents = [];
const controls = await import(
  pathToFileURL(path.resolve("dist/core/rin-builtin-extension-controls.js")).href
);
const root = process.env.RIN_TEST_BUILT_IN_ROOT;
const extensionDir = process.env.RIN_TEST_BUILT_IN_EXTENSION_DIR;
await fs.mkdir(extensionDir, { recursive: true });
await fs.writeFile(
  path.join(extensionDir, "index.ts"),
  [
    "export const builtInExtensionLifecycle = {",
    "  async status({ agentDir }) {",
    "    if (agentDir.endsWith('status-fail')) throw new Error('status unavailable');",
    "    return { status: 'ready', detail: agentDir };",
    "  },",
    "  install({ agentDir }) { globalThis.__rinBuiltInOwnerEvents.push(['install', agentDir]); },",
    "  start({ agentDir }) { globalThis.__rinBuiltInOwnerEvents.push(['start', agentDir]); },",
    "  stop({ agentDir }) { globalThis.__rinBuiltInOwnerEvents.push(['stop', agentDir]); },",
    "};",
  ].join("\n"),
);
const paths = [];
let flushes = 0;
const manager = {
  agentDir: path.join(root, "agent"),
  globalSettings: { extensions: ["rin:owner-lifecycle", "external-owner"] },
  setExtensionPaths(value) { paths.push([...value]); this.globalSettings.extensions = [...value]; },
  async flush() { flushes += 1; },
};
const listed = controls.listBuiltInRinExtensionStates(manager);
assert.deepEqual(listed.map(({ id, enabled }) => ({ id, enabled })), [
  { id: "owner-lifecycle", enabled: true },
  { id: "owner-fallback", enabled: false },
]);
const lifecycle = await controls.listBuiltInRinExtensionStatesWithLifecycle(manager);
assert.deepEqual(lifecycle[0].lifecycle, {
  status: "ready",
  detail: path.join(root, "agent"),
});
assert.equal(lifecycle[1].lifecycle, undefined);
const fallbackManager = {
  storage: { agentDir: path.join(root, "status-fail") },
  getGlobalSettings: () => ({ extensions: ["rin:owner-lifecycle"] }),
};
const failedStatus = await controls.listBuiltInRinExtensionStatesWithLifecycle(fallbackManager);
assert.deepEqual(failedStatus[0].lifecycle, {
  status: "error",
  detail: "status unavailable",
});
assert.equal(controls.listBuiltInRinExtensionStates({}).every((entry) => !entry.enabled), true);

await controls.disableBuiltInRinExtension(manager, "owner-lifecycle");
await controls.enableBuiltInRinExtension(manager, "owner-lifecycle");
const fallbackState = await controls.setBuiltInRinExtensionState(
  manager,
  "owner-fallback",
  true,
  { agentDir: path.join(root, "override-agent") },
);
assert.equal(fallbackState.enabled, true);
await controls.setBuiltInRinExtensionState({}, "owner-fallback", false);
await assert.rejects(
  () => controls.enableBuiltInRinExtension(manager, "owner-unknown"),
  /Unknown built-in Rin extension: owner-unknown/,
);
assert.deepEqual(globalThis.__rinBuiltInOwnerEvents, [
  ["stop", path.join(root, "agent")],
  ["install", path.join(root, "agent")],
  ["start", path.join(root, "agent")],
  ["fallback", path.join(root, "override-agent")],
]);
assert.equal(flushes, 3);
assert.equal(paths.length, 3);
assert.equal(paths.at(-1).includes("rin:owner-fallback"), true);
console.log(JSON.stringify({ listed, lifecycle, failedStatus, events: globalThis.__rinBuiltInOwnerEvents, flushes, paths }));
`;

test("built-in controls own settings and extension lifecycle transitions", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-built-in-owner-"));
  try {
    const result = await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        registerFixture,
        "--input-type=module",
        "-e",
        childScript,
      ],
      {
        env: {
          ...process.env,
          RIN_TEST_BUILT_IN_ROOT: root,
          RIN_TEST_BUILT_IN_EXTENSION_DIR: path.join(root, "extension"),
        },
      },
    );
    const report = JSON.parse(result.stdout);
    assert.equal(report.listed.length, 2);
    assert.equal(report.events.length, 4);
    assert.equal(report.flushes, 3);
    assert.equal(result.stderr, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
