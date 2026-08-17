import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const { createAuthStorageProxy } = await importBuiltModule<
  typeof import("../../src/core/rin-frontend-sdk/rpc-auth.js")
>("dist/core/rin-frontend-sdk/rpc-auth.js");

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("RPC auth proxy normalizes daemon state without exposing credential values", async () => {
  const sent: any[] = [];
  const auth = createAuthStorageProxy({
    async send(payload: any) {
      sent.push(payload);
      return payload.type === "get_oauth_state"
        ? {
            success: true,
            data: {
              credentials: {
                " openai ": { type: " oauth " },
                gemini: {},
                "": { type: "bad" },
              },
              providers: [
                { id: " openai ", name: " OpenAI ", usesCallbackServer: 1 },
                { id: "openai", name: "duplicate" },
                { id: "gemini", name: "" },
                null,
              ],
              providerDisplayNames: { " openai ": " OpenAI ", blank: "" },
              providerAuthStatuses: {
                openai: {
                  configured: true,
                  source: " oauth ",
                  label: " Account ",
                },
                gemini: { configured: 0 },
                "": { configured: true },
              },
            },
          }
        : { success: true, data: {} };
    },
  } as any);

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
  assert.equal(auth.getProviderDisplayName("unknown"), "unknown");
  assert.equal(auth.getProviderDisplayName(""), "");
  assert.deepEqual(auth.getProviderAuthStatus("openai"), {
    configured: true,
    source: "oauth",
    label: "Account",
  });
  assert.deepEqual(auth.getProviderAuthStatus("unknown"), {
    configured: false,
  });

  auth.applyState(null);
  assert.deepEqual(auth.list(), []);
  await createAuthStorageProxy({
    async send() {
      return { success: false };
    },
  } as any).sync();
});

test("RPC auth proxy completes every interactive login event and failure path", async () => {
  const sent: any[] = [];
  const observed: any[] = [];
  const auth = createAuthStorageProxy({
    async send(payload: any) {
      sent.push(payload);
      if (payload.type === "oauth_login_start")
        return { success: true, data: { loginId: " login-1 " } };
      return { success: true, data: {} };
    },
  } as any);

  const login = auth.login(" openai ", {
    onAuth: (value: any) => observed.push(["auth", value]),
    onProgress: (value: any) => observed.push(["progress", value]),
    onDeviceCode: (value: any) => observed.push(["device", value]),
    onPrompt: async (value: any) => (
      observed.push(["prompt", value]),
      "answer"
    ),
    onSelect: async (value: any) => (
      observed.push(["select", value]),
      undefined
    ),
    onManualCodeInput: async () => "manual",
  });
  await turn();
  auth.handleEvent(null);
  auth.handleEvent({ type: "other" });
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "unknown",
    event: "progress",
  });
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-1",
    event: "auth",
    url: "url",
    instructions: 7,
  });
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-1",
    event: "progress",
    message: "working",
  });
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-1",
    event: "device_code",
    userCode: "code",
    verificationUri: "verify",
  });
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-1",
    event: "prompt",
    requestId: "request-1",
    message: "Prompt",
    placeholder: 9,
  });
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-1",
    event: "select",
    requestId: "request-2",
    message: "Select",
    options: [{ id: "one" }, null],
  });
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-1",
    event: "manual_code",
    requestId: "request-3",
  });
  await turn();
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "login-1",
    event: "complete",
    success: true,
    state: { credentials: { openai: { type: "oauth" } } },
  });
  await login;
  assert.equal(observed.length, 5);
  assert.deepEqual(auth.get("openai"), { type: "oauth" });
  assert.deepEqual(
    sent
      .filter((item) => item.type === "oauth_login_respond")
      .map((item) => item.value),
    ["answer", "", "manual"],
  );

  await assert.rejects(auth.login("", {}), /oauth_provider_id_required/);
  const failedStart = createAuthStorageProxy({
    async send() {
      return { success: false, error: "start failed" };
    },
  } as any);
  await assert.rejects(failedStart.login("openai"), /start failed/);

  const failedComplete = createAuthStorageProxy({
    async send(payload: any) {
      return payload.type === "oauth_login_start"
        ? { success: true, data: { loginId: "failed" } }
        : { success: true };
    },
  } as any);
  const rejected = failedComplete.login("openai");
  await turn();
  failedComplete.handleEvent({
    type: "oauth_login_event",
    loginId: "failed",
    event: "complete",
    success: false,
  });
  await assert.rejects(rejected, /oauth_login_failed/);
});

test("RPC auth proxy rolls optimistic API-key and logout state forward or back", async () => {
  const sent: any[] = [];
  const outcomes = new Map<string, any>();
  const auth = createAuthStorageProxy({
    async send(payload: any) {
      sent.push(payload);
      const outcome = outcomes.get(payload.type);
      if (outcome instanceof Error) throw outcome;
      return outcome ?? { success: true, data: { credentials: {} } };
    },
  } as any);
  auth.applyState({ credentials: { openai: { type: "oauth" } } });

  auth.set("", { key: "value" });
  auth.set("openai", { key: "" });
  outcomes.set("oauth_set_api_key", { success: false });
  auth.set("openai", { key: " key " });
  assert.deepEqual(auth.get("openai"), { type: "api_key" });
  await turn();
  assert.deepEqual(auth.get("openai"), { type: "oauth" });

  outcomes.set("oauth_set_api_key", new Error("offline"));
  auth.set("new", { key: "key" });
  await turn();
  assert.equal(auth.get("new"), undefined);

  outcomes.set("oauth_logout", { success: false });
  auth.logout("openai");
  await turn();
  assert.deepEqual(auth.get("openai"), { type: "oauth" });
  outcomes.set("oauth_logout", new Error("offline"));
  auth.logout("openai");
  await turn();
  assert.deepEqual(auth.get("openai"), { type: "oauth" });
  auth.logout("");

  outcomes.set("oauth_set_api_key", {
    success: true,
    data: { credentials: { openai: { type: "api_key" } } },
  });
  auth.set("openai", { key: "final" });
  await turn();
  assert.deepEqual(auth.get("openai"), { type: "api_key" });
});

test("RPC auth proxy cancels aborted and rejected interactive prompts without leaking failures", async () => {
  const sent: any[] = [];
  const auth = createAuthStorageProxy({
    async send(payload: any) {
      sent.push(payload);
      if (payload.type === "oauth_login_start")
        return { success: true, data: { loginId: "abort-me" } };
      throw new Error("ignored transport failure");
    },
  } as any);
  const controller = new AbortController();
  const login = auth.login("openai", { signal: controller.signal });
  await turn();
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "abort-me",
    event: "prompt",
    requestId: "request",
    message: "Prompt",
  });
  auth.handleEvent({
    type: "oauth_login_event",
    loginId: "abort-me",
    event: "manual_code",
  });
  await turn();
  controller.abort();
  await assert.rejects(login, /Login cancelled/);
  await turn();
  assert.ok(sent.some((item) => item.type === "oauth_login_cancel"));

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const second = auth.login("openai", { signal: alreadyAborted.signal });
  await assert.rejects(second, /Login cancelled/);
});
