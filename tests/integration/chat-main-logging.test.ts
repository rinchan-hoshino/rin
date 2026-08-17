import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("chat bridge treats missing runtime adapters as a quiet idle state", async () => {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-logging-"),
  );
  const agentDir = path.join(tempRoot, "agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "settings.json"), "{}\n", "utf8");

  const script = `
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const rootDir = process.env.RIN_REPO_ROOT;
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args.map(String).join(" "));
    };

    const mainMod = await import(pathToFileURL(path.join(rootDir, "dist", "core", "chat", "main.js")).href);
    const bridge = await mainMod.startChatBridge({ commandRows: [] });
    await bridge.stop();
    console.warn = originalWarn;

    if (warnings.some((line) => line.includes("no runtime chat adapters configured"))) {
      throw new Error(JSON.stringify(warnings));
    }
  `;

  try {
    await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          RIN_REPO_ROOT: rootDir,
          RIN_DIR: agentDir,
        },
      },
    );
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
