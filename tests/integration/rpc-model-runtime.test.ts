import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
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

test("ModelRuntime login preserves the requested auth and prompt types", async () => {
  const observed = [];
  const result = await loginSessionProvider(
    {
      modelRuntime: {
        async login(providerId, authType, interaction) {
          observed.push({ providerId, authType });
          interaction.notify({
            type: "info",
            message: "Use a scoped key",
            links: [{ url: "https://example.com", label: "Docs" }],
          });
          return await interaction.prompt({
            type: "secret",
            message: "Enter API key",
          });
        },
      },
    },
    "openai",
    {
      authType: "api_key",
      onPrompt(prompt) {
        observed.push(prompt);
        return Promise.resolve("test-key");
      },
      onInfo(info) {
        observed.push(info);
      },
    },
  );

  assert.equal(result, "test-key");
  assert.deepEqual(observed, [
    { providerId: "openai", authType: "api_key" },
    {
      type: "info",
      message: "Use a scoped key",
      links: [{ url: "https://example.com", label: "Docs" }],
    },
    {
      type: "secret",
      message: "Enter API key",
      placeholder: undefined,
      allowEmpty: true,
      signal: undefined,
    },
  ]);
});

test("ModelRuntime OAuth bridges every prompt, notification, and combined signal", async () => {
  const loginSignal = new AbortController().signal;
  const promptSignal = new AbortController().signal;
  const observed: string[] = [];
  const result = await loginSessionProvider(
    {
      modelRuntime: {
        async login(_providerId, _type, interaction) {
          await interaction.prompt({
            type: "select",
            message: "Choose",
            options: ["owner"],
            signal: promptSignal,
          });
          interaction.notify({ type: "auth_url", url: "https://owner" });
          interaction.notify({ type: "device_code", code: "OWNER" });
          interaction.notify({ type: "progress", message: "waiting" });
          interaction.notify({ type: "unknown" });
          return "oauth-owner";
        },
      },
    },
    "owner",
    {
      signal: loginSignal,
      onSelect(prompt) {
        assert.notEqual(prompt.signal, loginSignal);
        assert.notEqual(prompt.signal, promptSignal);
        observed.push("select");
        return Promise.resolve("owner");
      },
      onAuth: () => observed.push("auth"),
      onDeviceCode: () => observed.push("device"),
      onProgress: () => observed.push("progress"),
    },
  );
  assert.equal(result, "oauth-owner");
  assert.deepEqual(observed, ["select", "auth", "device", "progress"]);
});

test("ModelRuntime OAuth delegates to compatible credential storage", async () => {
  const callbacks = { authType: "oauth", marker: "owner" };
  assert.equal(
    await loginSessionProvider(
      {
        modelRuntime: {
          authStorage: {
            login(providerId, received) {
              assert.equal(providerId, "owner");
              assert.equal(received, callbacks);
              return "stored-oauth";
            },
          },
        },
      },
      "owner",
      callbacks as any,
    ),
    "stored-oauth",
  );
});

test("ModelRuntime API keys use compatible credential storage when available", async () => {
  const calls = [];
  await setSessionApiKey(
    {
      modelRegistry: {
        authStorage: {
          set(providerId, credential) {
            calls.push([providerId, credential]);
          },
        },
        async refresh() {
          calls.push(["refresh"]);
        },
      },
    },
    "owner",
    "owner-key",
  );
  assert.deepEqual(calls, [
    ["owner", { type: "api_key", key: "owner-key" }],
    ["refresh"],
  ]);
  await assert.rejects(
    loginSessionProvider({} as any, "owner", {} as any),
    /rin_session_model_runtime_unavailable/,
  );
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
