import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../..",
);
const { createAuthStorageProxy } = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-tui", "rpc-auth.js"))
    .href
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
});

test("rpc auth proxy responds to oauth login events and applies completion state", async () => {
  const sent = [];
  const authEvents = [];
  const progressEvents = [];
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
    onPrompt: async () => " code ",
    onManualCodeInput: async () => "123456",
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
    loginId: " login-1 ",
    event: "prompt",
    requestId: " req-1 ",
    message: "Enter code",
  });
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-1",
    event: "manual_code",
    requestId: " req-2 ",
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
      value: "123456",
    },
  ]);
  assert.deepEqual(auth.get("openai"), { type: "oauth" });
  assert.deepEqual(auth.getOAuthProviders(), [
    { id: "openai", name: "OpenAI" },
  ]);
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
