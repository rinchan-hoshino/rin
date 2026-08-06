import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const { runCustomRpcMode } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "rpc-mode.js"))
    .href
);

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test(
  "rpc setting writes serialize flush and error attribution",
  { concurrency: false },
  async () => {
    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines: string[] = [];
    const finishFlushes: Array<() => void> = [];
    let settingsErrors: any[] = [
      { scope: "global", error: new Error("first write failed") },
    ];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const session = {
        isStreaming: false,
        isCompacting: false,
        get thinkingLevel() {
          return this.agent.state.thinkingLevel;
        },
        agent: {
          state: { thinkingLevel: "high" },
          waitForIdle: async () => {},
        },
        bindExtensions: async () => {},
        subscribe: () => () => {},
        setThinkingLevel() {},
        setSteeringMode() {},
        settingsManager: {
          getDefaultThinkingLevel: () => "low",
          setDefaultThinkingLevel() {},
          flush() {
            return new Promise<void>((resolve) => finishFlushes.push(resolve));
          },
          drainErrors() {
            const errors = settingsErrors;
            settingsErrors = [];
            return errors;
          },
        },
      };

      void runCustomRpcMode(session, {
        SessionManager: { listAll: async () => [], list: async () => [] },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "set_thinking_level", level: "high" })}\n${JSON.stringify({ id: "2", type: "set_steering_mode", mode: "all" })}\n`,
        ),
      );
      await wait(0);

      assert.equal(finishFlushes.length, 1);
      finishFlushes[0]();
      await wait(0);
      assert.equal(finishFlushes.length, 2);
      finishFlushes[1]();
      await wait(0);

      const responses = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((line) => line?.type === "response");
      assert.equal(responses.find((line) => line.id === "1")?.success, false);
      assert.match(
        responses.find((line) => line.id === "1")?.error,
        /first write failed/,
      );
      assert.equal(responses.find((line) => line.id === "2")?.success, true);
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
    }
  },
);

test(
  "rpc thinking acknowledgement repairs a stale same-level persisted default",
  { concurrency: false },
  async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "rin-rpc-settings-persistence-"),
    );
    const agentDir = path.join(tempDir, "agent");
    const cwd = path.join(tempDir, "cwd");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify({ defaultThinkingLevel: "low" }, null, 2)}\n`,
      "utf8",
    );

    const stdinOn = process.stdin.on;
    const stdoutWrite = process.stdout.write;
    const handlers = new Map();
    const lines: string[] = [];

    process.stdin.on = function (event, handler) {
      handlers.set(event, handler);
      return this;
    };
    process.stdout.write = function (chunk) {
      lines.push(String(chunk));
      return true;
    };

    try {
      const settingsManager = SettingsManager.create(cwd, agentDir);
      const session = {
        isStreaming: false,
        isCompacting: false,
        get thinkingLevel() {
          return this.agent.state.thinkingLevel;
        },
        agent: {
          state: { thinkingLevel: "high" },
          waitForIdle: async () => {},
        },
        settingsManager,
        bindExtensions: async () => {},
        subscribe: () => () => {},
        setThinkingLevel() {},
      };

      void runCustomRpcMode(session, {
        SessionManager: { listAll: async () => [], list: async () => [] },
      });
      await wait(0);

      const onData = handlers.get("data");
      assert.equal(typeof onData, "function");
      onData(
        Buffer.from(
          `${JSON.stringify({ id: "1", type: "set_thinking_level", level: "high" })}\n`,
        ),
      );

      let response;
      for (let attempt = 0; attempt < 50 && !response; attempt += 1) {
        await wait(2);
        response = lines
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .find((line) => line?.type === "response" && line.id === "1");
      }
      assert.equal(response?.success, true);

      const saved = JSON.parse(
        await fs.readFile(path.join(agentDir, "settings.json"), "utf8"),
      );
      assert.equal(saved.defaultThinkingLevel, "high");
    } finally {
      process.stdin.on = stdinOn;
      process.stdout.write = stdoutWrite;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);
