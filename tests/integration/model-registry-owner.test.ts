import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const { createModelRegistry } = await importBuiltModule<
  typeof import("../../src/core/rin-frontend-sdk/model-registry.js")
>("dist/core/rin-frontend-sdk/model-registry.js");

test("model registry synchronizes model and provider state", async () => {
  const sent: string[] = [];
  const allModels = [
    { provider: "openai", id: "gpt-5" },
    { provider: "anthropic", id: "claude-sonnet" },
    { provider: "", id: "invalid" },
  ];
  const availableModels = [
    { provider: "openai", id: "gpt-5", source: "available" },
  ];
  const registry = createModelRegistry({
    async send(payload: { type: string }) {
      sent.push(payload.type);
      if (payload.type === "get_all_models") {
        return { success: true, data: { models: allModels } };
      }
      if (payload.type === "get_available_models") {
        return { success: true, data: { models: availableModels } };
      }
      if (payload.type === "get_oauth_state") {
        return {
          success: true,
          data: {
            credentials: { anthropic: { type: "oauth" } },
            providerDisplayNames: { anthropic: "Anthropic" },
            providerAuthStatuses: {
              openai: { configured: true, source: "environment" },
            },
            modelProviders: [
              {
                id: "openai",
                name: "OpenAI",
                auth: {
                  apiKey: { name: "API key", interactive: true },
                },
              },
              {
                id: "anthropic",
                name: "Anthropic",
                auth: {
                  oauth: { name: "OAuth", loginLabel: "Sign in" },
                },
              },
            ],
          },
        };
      }
      throw new Error(`unexpected:${payload.type}`);
    },
  } as any);

  assert.deepEqual(registry.getAll(), []);
  assert.deepEqual(registry.getAvailable(), []);
  assert.equal(registry.getError(), undefined);
  await registry.sync();

  assert.deepEqual(registry.getAll(), allModels);
  assert.notEqual(registry.getAll(), registry.getAll());
  assert.deepEqual(registry.getAvailable(), [availableModels[0], allModels[1]]);
  assert.deepEqual(registry.find("anthropic", "claude-sonnet"), allModels[1]);
  assert.equal(registry.find("missing", "model"), undefined);
  assert.equal(registry.getProviderDisplayName("anthropic"), "Anthropic");
  assert.deepEqual(registry.getProviderAuthStatus("openai"), {
    configured: true,
    source: "environment",
  });
  assert.equal(registry.isUsingOAuth(allModels[1]), true);
  assert.equal(registry.isUsingOAuth(allModels[0]), false);
  assert.deepEqual(registry.getModels("anthropic"), [allModels[1]]);
  assert.deepEqual(registry.getModels({ provider: "openai" } as any), [
    allModels[0],
  ]);
  assert.deepEqual(registry.getAvailable("anthropic"), [allModels[1]]);
  assert.deepEqual(registry.getAvailableSnapshot(), [
    availableModels[0],
    allModels[1],
  ]);
  assert.equal(registry.getModel("openai", "gpt-5"), allModels[0]);
  assert.equal(registry.getProvider(" anthropic ")?.name, "Anthropic");
  const providers = registry.getProviders();
  assert.equal(providers.length, 2);
  assert.throws(
    () => providers[0].auth.apiKey?.login?.(),
    /Provider login must be started through modelRuntime.login/,
  );
  assert.throws(
    () => providers[1].auth.oauth?.login(),
    /Provider login must be started through modelRuntime.login/,
  );
  assert.deepEqual(await registry.checkAuth("anthropic"), { type: "oauth" });
  assert.deepEqual(await registry.checkAuth("openai"), { type: "api_key" });
  assert.equal(await registry.checkAuth("missing"), undefined);
  assert.equal(await registry.getAuth("anthropic"), undefined);
  assert.deepEqual(await registry.listCredentials(), [
    { providerId: "anthropic", type: "oauth" },
  ]);
  assert.deepEqual(sent, [
    "get_all_models",
    "get_available_models",
    "get_oauth_state",
    "get_all_models",
    "get_available_models",
    "get_oauth_state",
    "get_all_models",
    "get_available_models",
    "get_oauth_state",
    "get_all_models",
    "get_available_models",
    "get_oauth_state",
  ]);
});

test("model registry tolerates malformed responses and records transport errors", async () => {
  let fail = false;
  let sends = 0;
  const registry = createModelRegistry({
    async send() {
      sends += 1;
      if (fail) throw new Error("offline");
      return { success: false, data: { models: [{ provider: "x", id: "y" }] } };
    },
  } as any);

  await registry.sync();
  assert.deepEqual(registry.getAll(), []);
  assert.deepEqual(registry.getAvailable(), []);
  assert.equal(registry.getError(), "Failed to synchronize model catalog");

  fail = true;
  await registry.sync();
  assert.equal(registry.getError(), "offline");

  fail = false;
  registry.refresh();
  for (
    let attempt = 0;
    attempt < 50 && registry.getError() === "offline";
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(registry.getError(), "Failed to synchronize model catalog");
  assert.ok(sends >= 9);
});

test("model registry refresh, login, and logout preserve daemon authority", async () => {
  let listener: ((event: any) => void) | undefined;
  let credentials: Record<string, { type: string }> = {};
  const state = () => ({
    credentials,
    providers: [],
    modelProviders: [],
    providerDisplayNames: {},
    providerAuthStatuses: {},
  });
  const client = {
    onEvent(next: (event: any) => void) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async send(payload: any) {
      if (
        payload.type === "get_all_models" ||
        payload.type === "get_available_models"
      ) {
        return { success: true, data: { models: [] } };
      }
      if (payload.type === "get_oauth_state") {
        return { success: true, data: state() };
      }
      if (payload.type === "oauth_login_start") {
        setImmediate(() => {
          for (const event of [
            { event: "auth", url: "https://auth.invalid" },
            {
              event: "device_code",
              userCode: "code",
              verificationUri: "https://device.invalid",
            },
            { event: "progress", message: "working" },
            { event: "info", message: "notice" },
            {
              event: "prompt",
              requestId: "prompt-1",
              promptType: "text",
              message: "value?",
            },
            {
              event: "select",
              requestId: "select-1",
              message: "choose",
              options: [{ id: "one", label: "One" }],
            },
            {
              event: "manual_code",
              requestId: "manual-1",
              message: "paste",
            },
          ]) {
            registry.authStorage.handleEvent({
              type: "oauth_login_event",
              loginId: "login-1",
              ...event,
            });
          }
          registry.authStorage.handleEvent({
            type: "oauth_login_event",
            loginId: "login-1",
            event: "complete",
            success: true,
            state: { ...state(), credentials: { custom: { type: "oauth" } } },
          });
        });
        return { success: true, data: { loginId: "login-1" } };
      }
      if (payload.type === "oauth_logout") {
        credentials = {};
        return { success: true, data: state() };
      }
      throw new Error(`unexpected:${payload.type}`);
    },
  } as any;
  const registry = createModelRegistry(client);
  void listener;

  assert.deepEqual(await registry.refresh(), {
    aborted: false,
    errors: new Map(),
  });
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  assert.deepEqual(await registry.refresh({ signal: alreadyAborted.signal }), {
    aborted: true,
    errors: new Map(),
  });
  const duringRefresh = new AbortController();
  const refresh = registry.refresh({ signal: duringRefresh.signal });
  duringRefresh.abort();
  assert.equal((await refresh).aborted, true);

  const notices: any[] = [];
  assert.deepEqual(
    await registry.login(" custom ", "oauth", {
      notify: (value: any) => notices.push(value),
      prompt: async () => "answer",
    }),
    { type: "oauth" },
  );
  assert.deepEqual(
    notices.map((notice) => notice.type),
    ["auth_url", "device_code", "progress", "info"],
  );
  assert.equal(registry.isUsingOAuth("custom"), false);
  await registry.logout("custom");
  assert.equal(registry.isUsingOAuth("custom"), false);
});

test("model registry refresh reports synchronization errors", async () => {
  const registry = createModelRegistry({
    async send() {
      throw "offline-string";
    },
  } as any);
  const result = await registry.refresh();
  assert.equal(result.aborted, false);
  assert.match(
    result.errors.get("rin-daemon")?.message || "",
    /offline-string/,
  );
});

test("model registry normalizes successful non-array model payloads", async () => {
  const registry = createModelRegistry({
    async send(payload: { type: string }) {
      if (payload.type === "get_all_models") {
        return { success: true, data: { models: null } };
      }
      if (payload.type === "get_available_models") {
        return { success: true, data: {} };
      }
      return { success: true, data: null };
    },
  } as any);

  await registry.sync();
  assert.deepEqual(registry.getAll(), []);
  assert.deepEqual(registry.getAvailable(), []);
});
