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
  assert.deepEqual(sent, [
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
  assert.equal(registry.getError(), undefined);

  fail = true;
  await registry.sync();
  assert.equal(registry.getError(), "offline");

  fail = false;
  registry.refresh();
  for (let attempt = 0; attempt < 50 && registry.getError(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(registry.getError(), undefined);
  assert.ok(sends >= 9);
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
