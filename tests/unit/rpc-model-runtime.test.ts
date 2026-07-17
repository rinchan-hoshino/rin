import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const {
  deferOAuthLoginStart,
  loginSessionProvider,
  nextOAuthLoginRequestId,
  setSessionApiKey,
} = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-daemon", "rpc-mode.js"))
    .href
);

test("OAuth start response precedes a synchronous first provider prompt", async () => {
  const events = [];
  deferOAuthLoginStart(() => {
    events.push("prompt");
  });
  events.push("start_response");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start_response", "prompt"]);
});

test("OAuth prompt request IDs are never reused after cancellation", () => {
  const login = { nextWaitSeq: 0 };
  const cancelledRequestId = nextOAuthLoginRequestId(
    login,
    "login-1",
    "prompt",
  );
  // A delayed response to the cancelled request must not target this new wait.
  const replacementRequestId = nextOAuthLoginRequestId(
    login,
    "login-1",
    "prompt",
  );
  assert.equal(cancelledRequestId, "login-1:prompt:1");
  assert.equal(replacementRequestId, "login-1:prompt:2");
  assert.notEqual(cancelledRequestId, replacementRequestId);
});

test("ModelRuntime API keys use the persistent login path", async () => {
  const calls = [];
  const credentials = [];
  const modelRuntime = {
    async login(providerId, type, interaction) {
      const key = await interaction.prompt({
        type: "secret",
        message: "Enter API key",
      });
      calls.push({ providerId, type, key });
      credentials.push({ providerId, type });
    },
    async listCredentials() {
      return [...credentials];
    },
    async refresh() {
      calls.push({ refresh: true });
    },
  };
  await setSessionApiKey(
    {
      modelRuntime,
    },
    "openai",
    "test-key",
  );
  assert.deepEqual(calls, [
    { providerId: "openai", type: "api_key", key: "test-key" },
    { refresh: true },
  ]);
  assert.deepEqual(await modelRuntime.listCredentials(), [
    { providerId: "openai", type: "api_key" },
  ]);
});

test("ModelRuntime API-key RPC rejects compound provider setup", async () => {
  const credentials = [];
  const modelRuntime = {
    async login(providerId, type, interaction) {
      const key = await interaction.prompt({
        type: "secret",
        message: "Enter API key",
      });
      const accountId = await interaction.prompt({
        type: "text",
        message: "Enter account ID",
      });
      credentials.push({ providerId, type, key, accountId });
    },
    async refresh() {},
  };
  await assert.rejects(
    setSessionApiKey({ modelRuntime }, "cloudflare-ai-gateway", "test-key"),
    /requires interactive API-key setup/,
  );
  assert.deepEqual(credentials, []);
});

test("ModelRuntime OAuth forwards manual-code prompt cancellation", async () => {
  const controller = new AbortController();
  let capturedPrompt;
  const result = loginSessionProvider(
    {
      modelRuntime: {
        async login(_providerId, type, interaction) {
          assert.equal(type, "oauth");
          const pending = interaction.prompt({
            type: "manual_code",
            message: "Paste code",
            placeholder: "code",
            signal: controller.signal,
          });
          controller.abort();
          return await pending;
        },
      },
    },
    "openai",
    {
      onManualCodeInput(prompt) {
        capturedPrompt = prompt;
        return new Promise((_resolve, reject) => {
          prompt.signal.addEventListener(
            "abort",
            () => reject(new Error("prompt aborted")),
            { once: true },
          );
        });
      },
    },
  );
  await assert.rejects(result, /prompt aborted/);
  assert.equal(capturedPrompt.message, "Paste code");
  assert.equal(capturedPrompt.placeholder, "code");
  assert.equal(capturedPrompt.signal, controller.signal);
});

test("ModelRuntime OAuth preserves blank text prompts and login cancellation", async () => {
  const controller = new AbortController();
  let capturedPrompt;
  const result = loginSessionProvider(
    {
      modelRuntime: {
        async login(_providerId, _type, interaction) {
          const pending = interaction.prompt({
            type: "text",
            message: "Hostname (blank for github.com)",
          });
          controller.abort();
          return await pending;
        },
      },
    },
    "github-copilot",
    {
      signal: controller.signal,
      onPrompt(prompt) {
        capturedPrompt = prompt;
        return new Promise((_resolve, reject) => {
          prompt.signal.addEventListener(
            "abort",
            () => reject(new Error("login aborted")),
            { once: true },
          );
        });
      },
    },
  );
  await assert.rejects(result, /login aborted/);
  assert.equal(capturedPrompt.allowEmpty, true);
  assert.equal(capturedPrompt.message, "Hostname (blank for github.com)");
});
