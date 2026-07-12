import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const moduleUrl = (relativePath: string) =>
  pathToFileURL(
    path.join(rootDir, "dist", "core", "chat-runtime", relativePath),
  ).href;

test("chat runtime adapter barrels preserve per-platform constructor exports", async () => {
  const barrel = await import(moduleUrl("adapters.js"));
  const runtimeIndex = await import(moduleUrl("index.js"));
  const modules = {
    TelegramAdapter: await import(moduleUrl("adapters/telegram.js")),
    OneBotAdapter: await import(moduleUrl("adapters/onebot.js")),
    DiscordAdapter: await import(moduleUrl("adapters/discord.js")),
    SlackAdapter: await import(moduleUrl("adapters/slack.js")),
    QQAdapter: await import(moduleUrl("adapters/qq.js")),
    LarkAdapter: await import(moduleUrl("adapters/lark.js")),
    MinecraftAdapter: await import(moduleUrl("adapters/minecraft.js")),
  };

  for (const [name, platformModule] of Object.entries(modules)) {
    assert.equal(barrel[name], platformModule[name], `${name} adapter barrel`);
    assert.equal(
      runtimeIndex[name],
      platformModule[name],
      `${name} runtime index`,
    );
  }

  for (const name of [
    "ONEBOT_ACTION_TIMEOUT_MS",
    "ONEBOT_MEDIA_ACTION_TIMEOUT_MS",
    "oneBotActionTimeoutMs",
    "withOneBotActionTimeoutParam",
    "formatOneBotActionFailureMessage",
  ]) {
    assert.equal(runtimeIndex[name], modules.OneBotAdapter[name], name);
  }
});
