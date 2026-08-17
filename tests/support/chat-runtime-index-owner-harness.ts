import "./require-test-sandbox.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

await import("./register-chat-runtime-index-owner-fixture.ts");

export const owner = (globalThis as any).__chatRuntimeIndexOwner as Record<
  string,
  any
>;

export function resetOwner() {
  owner.apiCalls = [];
  owner.apiHandlers = {};
  owner.agents = [];
  owner.events = [];
  owner.webSockets = [];
  owner.wsOpenError = undefined;
  owner.wsSendError = undefined;
  owner.wsAutoReply = true;
  owner.wsReply = undefined;
}

export function logger() {
  const records: any[] = [];
  return {
    records,
    warn: (...args: any[]) => records.push(["warn", ...args]),
    info: (...args: any[]) => records.push(["info", ...args]),
    error: (...args: any[]) => records.push(["error", ...args]),
    debug: (...args: any[]) => records.push(["debug", ...args]),
  };
}

export async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-index-owner-"),
  );
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export function makeRuntime(
  runtime: any,
  directory: string,
  entry: Record<string, any>,
) {
  const target = runtime.createChat(directory);
  const created = runtime.addBuiltInPlatforms(target, {
    dataDir: path.join(directory, "data"),
    entries: [entry],
    logger: logger(),
  });
  assert.equal(created.length, 1);
  return {
    app: target as any,
    adapter: [...(target as any).platforms][0] as any,
    bot: target.bots[0] as any,
  };
}
