import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const { createAuthStorageProxy } = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "index.js"),
  ).href
);

test("rpc auth proxy normalizes oauth state snapshots", async () => {
  const sent = [];
  const auth = createAuthStorageProxy({
    send(payload) {
      sent.push(payload);
      if (payload.type === "get_oauth_state") {
        return Promise.resolve({
          success: true,
          data: {
            credentials: {
              " openai ": { type: " oauth " },
              "": { type: "ignored" },
              gemini: {},
            },
            providers: [
              { id: " openai ", name: " OpenAI ", usesCallbackServer: 1 },
              { id: "openai", name: "Duplicate" },
              { id: " gemini ", name: "" },
              { id: " ", name: "ignored" },
            ],
            providerDisplayNames: {
              " openai ": " OpenAI ",
              gemini: "",
            },
            providerAuthStatuses: {
              openai: {
                configured: true,
                source: " oauth ",
                label: " Account ",
              },
              gemini: { configured: false },
            },
          },
        });
      }
      return Promise.resolve({ success: true, data: {} });
    },
  });

  await auth.sync();

  assert.deepEqual(sent, [{ type: "get_oauth_state" }]);
  assert.deepEqual(auth.list().sort(), ["gemini", "openai"]);
  assert.deepEqual(auth.get(" openai "), { type: "oauth" });
  assert.equal(auth.get("gemini"), undefined);
  assert.deepEqual(auth.getOAuthProviders(), [
    { id: "openai", name: "OpenAI", usesCallbackServer: true },
    { id: "gemini", name: "gemini" },
  ]);
  assert.equal(auth.getProviderDisplayName(" openai "), "OpenAI");
  assert.equal(auth.getProviderDisplayName("gemini"), "gemini");
  assert.deepEqual(auth.getProviderAuthStatus("openai"), {
    configured: true,
    source: "oauth",
    label: "Account",
  });
  assert.deepEqual(auth.getProviderAuthStatus("gemini"), {
    configured: false,
  });
});

test("rpc auth proxy responds to oauth login events and applies completion state", async () => {
  const sent = [];
  const authEvents = [];
  const deviceCodeEvents = [];
  const progressEvents = [];
  const promptEvents = [];
  const selectPrompts = [];
  const manualCodePrompts = [];
  const auth = createAuthStorageProxy({
    send(payload) {
      sent.push(payload);
      if (payload.type === "oauth_login_start") {
        return Promise.resolve({
          success: true,
          data: { loginId: " login-1 " },
        });
      }
      return Promise.resolve({ success: true, data: {} });
    },
  });

  const loginPromise = auth.login(" openai ", {
    onAuth(info) {
      authEvents.push(info);
    },
    onProgress(message) {
      progressEvents.push(message);
    },
    onDeviceCode(info) {
      deviceCodeEvents.push(info);
    },
    onPrompt: async (prompt) => {
      promptEvents.push(prompt);
      return " code ";
    },
    onSelect: async (prompt) => {
      selectPrompts.push(prompt);
      return "device";
    },
    onManualCodeInput: async (prompt) => {
      manualCodePrompts.push(prompt);
      return "123456";
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  auth.handleEvent({
    type: "oauth_login_event",
    loginId: " login-1 ",
    event: "auth",
    url: "https://example.com/login",
    instructions: "Open browser",
  });
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-1",
    event: "progress",
    message: "Waiting",
  });
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-1",
    event: "device_code",
    userCode: "ABCD-EFGH",
    verificationUri: "https://example.com/device",
    intervalSeconds: 5,
    expiresInSeconds: 900,
  });
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: " login-1 ",
    event: "prompt",
    requestId: " req-1 ",
    message: "Enter code",
    placeholder: "optional.example.com",
    allowEmpty: true,
  });
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-1",
    event: "select",
    requestId: " req-2 ",
    message: "Choose login method",
    options: [
      { id: "browser", label: "Browser" },
      { id: "device", label: "Device code" },
    ],
  });
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-1",
    event: "manual_code",
    requestId: " req-3 ",
    message: "Paste authorization code",
    placeholder: "code",
  });

  await new Promise((resolve) => setImmediate(resolve));

  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-1",
    event: "complete",
    success: true,
    state: {
      credentials: { openai: { type: "oauth" } },
      providers: [{ id: " openai ", name: " OpenAI " }],
    },
  });

  await loginPromise;

  assert.deepEqual(authEvents, [
    {
      url: "https://example.com/login",
      instructions: "Open browser",
    },
  ]);
  assert.deepEqual(progressEvents, ["Waiting"]);
  assert.equal(promptEvents.length, 1);
  assert.equal(promptEvents[0].message, "Enter code");
  assert.equal(promptEvents[0].placeholder, "optional.example.com");
  assert.equal(promptEvents[0].allowEmpty, true);
  assert.ok(promptEvents[0].signal instanceof AbortSignal);
  assert.deepEqual(deviceCodeEvents, [
    {
      userCode: "ABCD-EFGH",
      verificationUri: "https://example.com/device",
      intervalSeconds: 5,
      expiresInSeconds: 900,
    },
  ]);
  assert.equal(selectPrompts.length, 1);
  assert.equal(selectPrompts[0].message, "Choose login method");
  assert.deepEqual(selectPrompts[0].options, [
    { id: "browser", label: "Browser" },
    { id: "device", label: "Device code" },
  ]);
  assert.ok(selectPrompts[0].signal instanceof AbortSignal);
  assert.equal(manualCodePrompts.length, 1);
  assert.equal(manualCodePrompts[0].message, "Paste authorization code");
  assert.equal(manualCodePrompts[0].placeholder, "code");
  assert.ok(manualCodePrompts[0].signal instanceof AbortSignal);
  assert.deepEqual(sent, [
    { type: "oauth_login_start", providerId: "openai" },
    {
      type: "oauth_login_respond",
      loginId: "login-1",
      requestId: "req-1",
      value: " code ",
    },
    {
      type: "oauth_login_respond",
      loginId: "login-1",
      requestId: "req-2",
      value: "device",
    },
    {
      type: "oauth_login_respond",
      loginId: "login-1",
      requestId: "req-3",
      value: "123456",
    },
  ]);
  assert.deepEqual(auth.get("openai"), { type: "oauth" });
  assert.deepEqual(auth.getOAuthProviders(), [
    { id: "openai", name: "OpenAI" },
  ]);
});

test("rpc auth proxy cancels stale interactive prompts without responding", async () => {
  const sent = [];
  let promptSignal;
  let resolvePrompt;
  const auth = createAuthStorageProxy({
    send(payload) {
      sent.push(payload);
      if (payload.type === "oauth_login_start") {
        return Promise.resolve({
          success: true,
          data: { loginId: "login-cancel" },
        });
      }
      return Promise.resolve({ success: true, data: {} });
    },
  });
  const loginPromise = auth.login("openai", {
    onPrompt(prompt) {
      promptSignal = prompt.signal;
      return new Promise((resolve) => {
        resolvePrompt = resolve;
      });
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-cancel",
    event: "prompt",
    requestId: "request-cancel",
    message: "Waiting for callback",
  });
  await new Promise((resolve) => setImmediate(resolve));
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-cancel",
    event: "prompt_cancel",
    requestId: "request-cancel",
  });
  assert.equal(promptSignal.aborted, true);
  resolvePrompt("stale response");
  await new Promise((resolve) => setImmediate(resolve));
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-cancel",
    event: "complete",
    success: true,
  });
  await loginPromise;
  assert.deepEqual(sent, [{ type: "oauth_login_start", providerId: "openai" }]);
});

test("rpc auth proxy stores API keys through the daemon", async () => {
  const sent = [];
  const auth = createAuthStorageProxy({
    send(payload) {
      sent.push(payload);
      if (payload.type === "oauth_set_api_key") {
        return Promise.resolve({
          success: true,
          data: {
            credentials: { openai: { type: "api_key" } },
            providers: [],
          },
        });
      }
      return Promise.resolve({ success: true, data: {} });
    },
  });

  auth.set(" openai ", { type: "api_key", key: " sk-test " });
  assert.deepEqual(auth.get("openai"), { type: "api_key" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(sent, [
    { type: "oauth_set_api_key", providerId: "openai", key: "sk-test" },
  ]);
  assert.deepEqual(auth.get("openai"), { type: "api_key" });
});

test("rpc auth proxy rolls back failed logout and cancels aborted logins", async () => {
  const sent = [];
  const auth = createAuthStorageProxy({
    send(payload) {
      sent.push(payload);
      if (payload.type === "oauth_login_start") {
        return Promise.resolve({ success: true, data: { loginId: "login-2" } });
      }
      if (payload.type === "oauth_logout") {
        return Promise.resolve({ success: false, error: "logout_failed" });
      }
      return Promise.resolve({ success: true, data: {} });
    },
  });

  auth.applyState({
    credentials: { openai: { type: "oauth" } },
    providers: [{ id: "openai", name: "OpenAI" }],
  });
  auth.logout(" openai ");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(auth.get("openai"), { type: "oauth" });

  const controller = new AbortController();
  const loginPromise = auth.login("openai", { signal: controller.signal });
  controller.abort();
  await assert.rejects(loginPromise, /Login cancelled/);

  assert.deepEqual(sent, [
    { type: "oauth_logout", providerId: "openai" },
    { type: "oauth_login_start", providerId: "openai" },
    { type: "oauth_login_cancel", loginId: "login-2" },
  ]);
});
