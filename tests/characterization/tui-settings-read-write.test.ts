import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const frontendSdkUrl = pathToFileURL(
  path.join(rootDir, "dist", "core", "rin-frontend-sdk", "index.js"),
).href;

test("explicit rpc ui persistence writes settings without needing a session", async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-rpc-write-"));
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify({ quietStartup: false }, null, 2)}\n`,
    "utf8",
  );

  const oldRinDir = process.env.RIN_DIR;
  process.env.RIN_DIR = agentDir;
  const stamp = Date.now();
  const { persistRpcSettingsMutation } = await import(
    `${frontendSdkUrl}?t=${stamp}`
  );

  await persistRpcSettingsMutation((settings) => {
    settings.setQuietStartup?.(true);
    settings.setSteeringMode?.("all");
  });

  if (oldRinDir === undefined) delete process.env.RIN_DIR;
  else process.env.RIN_DIR = oldRinDir;

  const saved = JSON.parse(
    fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"),
  );
  assert.equal(saved.quietStartup, true);
  assert.equal(saved.steeringMode, "all");
});
