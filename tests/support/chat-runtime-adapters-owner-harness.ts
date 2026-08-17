import "./require-test-sandbox.ts";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

await import("./register-chat-runtime-adapters-owner-fixture.ts");

export const owner = (globalThis as any).__chatRuntimeAdaptersOwner as Record<
  string,
  any
>;

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

export function app(agentDir?: string) {
  const records: any[] = [];
  const registered: any[] = [];
  return {
    agentDir,
    records,
    registered,
    register(adapter: any, bot: any) {
      registered.push({ adapter, bot });
    },
    emit(name: string, payload: any) {
      records.push([name, payload]);
      return true;
    },
  };
}

export function resetOwner() {
  owner.events = [];
  owner.discordClients = [];
  owner.discordUser = {
    id: "discord-bot",
    username: "rin-bot",
    globalName: "Rin Bot",
  };
  owner.discordChannels = {
    fetch: async (id: string) => owner.discordChannelById?.[id],
  };
  owner.discordGuilds = {
    fetch: async (id: string) => owner.discordGuildById?.[id],
  };
  owner.discordApplication = {
    id: "discord-app",
    commands: { set: async () => true },
  };
  owner.discordRest = { put: async () => true };
  owner.discordChannelById = {};
  owner.discordGuildById = {};
  owner.discordLoginError = undefined;
  owner.discordDestroyError = undefined;
}

export async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rin-chat-adapters-owner-"),
  );
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
