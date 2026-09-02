import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as providerAuth from "../../dist/core/rin-install/provider-auth.js";

async function withTempDir(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-provider-owner-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fsSync.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function fakeSpinner(log: string[]) {
  return {
    start(message: string) {
      log.push(`start:${message}`);
    },
    stop(message: string) {
      log.push(`stop:${message}`);
    },
    message(message: string) {
      log.push(`message:${message}`);
    },
  };
}

const copy = {
  loadingModelChoicesMessage: "loading models",
  installStepComplete: "step complete",
  installStepFailed: "step failed",
  startingLogin: (name: string) => `starting ${name}`,
  openUrlToContinueLogin: (url: string, detail?: string) =>
    `open ${url}${detail ? ` ${detail}` : ""}`,
  deviceCodeLoginInstructions: (code: string) => `device ${code}`,
  enterLoginValueMessage: "enter login value",
  waitingForLogin: (name: string) => `waiting ${name}`,
  manualCodeInputMessage: "enter manual code",
  manualCodePlaceholder: (url: string) => `from ${url}`,
  loginComplete: (name: string) => `complete ${name}`,
  loginFailed: (name: string) => `failed ${name}`,
  enterApiKeyMessage: (name: string) => `api key ${name}`,
  valueRequired: "value required",
  tokenRequired: "token required",
  savingProviderAuthMessage: "saving auth",
};

test("provider auth discovers configured API, subscription, and custom models", async () => {
  await withTempDir(async (root) => {
    await fs.writeFile(
      path.join(root, "auth.json"),
      JSON.stringify({ openai: { type: "api_key", key: "owner-test" } }),
    );
    await fs.writeFile(
      path.join(root, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: "http://127.0.0.1:11434/v1",
            apiKey: "literal:owner-test",
            api: "openai",
            models: [
              {
                id: "local-reasoner",
                reasoning: true,
                thinkingLevelMap: { xhigh: "xhigh", max: null },
              },
            ],
          },
        },
      }),
    );

    const choices = await providerAuth.loadModelChoices(root, readJson);
    const custom = choices.find(
      (choice) => choice.provider === "local" && choice.id === "local-reasoner",
    );
    assert.ok(custom);
    assert.equal(custom.provider, "local");
    assert.equal(custom.providerLabel, "local");
    assert.equal(custom.authKind, "api");
    assert.equal(custom.id, "local-reasoner");
    assert.equal(custom.reasoning, true);
    assert.equal(custom.available, true);
    assert.equal(custom.api, "openai");
    assert.equal(custom.baseUrl, "http://127.0.0.1:11434/v1");
    assert.deepEqual(custom.thinkingLevelMap, {
      xhigh: "xhigh",
      max: null,
    });
    assert.ok(
      choices.some(
        (choice) =>
          choice.provider === "openai" &&
          choice.authKind === "api" &&
          choice.available,
      ),
    );
    assert.ok(
      choices.some(
        (choice) =>
          choice.provider === "openai-codex" &&
          choice.authKind === "subscription",
      ),
    );

    const authStorage = await providerAuth.createInstallerAuthStorage(
      root,
      readJson,
    );
    assert.equal(authStorage.hasAuth("openai"), true);
  });

  const defaults = await providerAuth.loadModelChoices();
  assert.ok(defaults.length > 0);
});

test("provider auth returns existing credentials through injected and default storage", async () => {
  const result = await providerAuth.configureProviderAuth(
    "ready-provider",
    "/tmp/provider-owner",
    {
      readJsonFile: (_path, fallback) => fallback,
      ensureNotCancelled: (value) => value,
      copy: copy as any,
      async createAuthStorage() {
        return {
          hasAuth: () => true,
          getAll: () => ({ "ready-provider": { type: "api_key" } }),
        };
      },
    },
  );
  assert.deepEqual(result, {
    available: true,
    authKind: "existing",
    authData: { "ready-provider": { type: "api_key" } },
  });

  const withoutSnapshot = await providerAuth.configureProviderAuth(
    "ready-provider",
    "/tmp/provider-owner",
    {
      readJsonFile: (_path, fallback) => fallback,
      ensureNotCancelled: (value) => value,
      copy: copy as any,
      async createAuthStorage() {
        return { hasAuth: () => true };
      },
    },
  );
  assert.deepEqual(withoutSnapshot.authData, {});

  await withTempDir(async (root) => {
    await fs.writeFile(
      path.join(root, "auth.json"),
      JSON.stringify({ defaultStorage: { type: "api_key", key: "saved" } }),
    );
    const fromDefaultStorage = await providerAuth.configureProviderAuth(
      "defaultStorage",
      root,
      {
        readJsonFile: readJson,
        ensureNotCancelled: (value) => value,
        copy: copy as any,
      },
    );
    assert.equal(fromDefaultStorage.authKind, "existing");
  });
});

test("provider auth drives the complete OAuth callback contract", async () => {
  const spinnerLog: string[] = [];
  const promptValidations: Array<string | undefined> = [];
  const selected: Array<string | undefined> = [];
  let textPromptCall = 0;
  let selectPromptCall = 0;

  const result = await providerAuth.configureProviderAuth(
    "subscription-owner",
    "/tmp/provider-owner",
    {
      readJsonFile: (_path, fallback) => fallback,
      ensureNotCancelled: (value) => value,
      copy: copy as any,
      spinnerFactory: (() => fakeSpinner(spinnerLog)) as any,
      async textPrompt(options: any) {
        promptValidations.push(options.validate(""));
        textPromptCall += 1;
        if (textPromptCall === 1) return " tenant.example ";
        if (textPromptCall === 2) return "";
        return " manual-code ";
      },
      async selectPrompt(options: any) {
        assert.deepEqual(options.options, [
          { value: "browser", label: "browser" },
          { value: "device", label: "Device" },
        ]);
        selectPromptCall += 1;
        return selectPromptCall === 1 ? "device" : "";
      },
      async createAuthStorage() {
        return {
          hasAuth: () => false,
          getOAuthProviders: () => [
            { id: "subscription-owner", name: "Owner Subscription" },
          ],
          async login(_provider: string, callbacks: any) {
            callbacks.onAuth({
              url: "https://login.example/authorize",
              instructions: "continue in browser",
            });
            callbacks.onAuth(undefined);
            callbacks.onDeviceCode({
              userCode: "ABCD-EFGH",
              verificationUri: "https://login.example/device",
            });
            callbacks.onDeviceCode(undefined);
            callbacks.onDeviceCode({
              userCode: "",
              verificationUri: "https://login.example/device-2",
            });
            assert.equal(
              await callbacks.onPrompt({
                message: "Enterprise host",
                placeholder: "company.example",
                allowEmpty: false,
              }),
              "tenant.example",
            );
            assert.equal(
              await callbacks.onPrompt({
                message: "Optional tenant",
                allowEmpty: true,
              }),
              "",
            );
            assert.equal(
              await callbacks.onPrompt({ message: "", allowEmpty: true }),
              "manual-code",
            );
            callbacks.onProgress("");
            callbacks.onProgress("authorizing");
            selected.push(
              await callbacks.onSelect({
                message: "Login method",
                options: [
                  null,
                  { id: "", label: "ignored" },
                  { id: "browser", label: "" },
                  { id: "device", label: "Device" },
                ],
              }),
            );
            selected.push(
              await callbacks.onSelect({
                message: "",
                options: [
                  { id: "browser", label: "" },
                  { id: "device", label: "Device" },
                ],
              }),
            );
            assert.equal(
              await callbacks.onSelect({ message: "Empty", options: [] }),
              undefined,
            );
            assert.equal(
              await callbacks.onSelect({ message: "Empty", options: null }),
              undefined,
            );
            assert.equal(await callbacks.onManualCodeInput(), "manual-code");
            assert.ok(callbacks.signal instanceof AbortSignal);
          },
          getAll: () => ({
            "subscription-owner": { type: "oauth", access: "saved" },
          }),
        };
      },
    },
  );

  assert.equal(result.available, true);
  assert.equal(result.authKind, "oauth");
  assert.deepEqual(selected, ["device", undefined]);
  assert.deepEqual(promptValidations, [
    "value required",
    undefined,
    undefined,
    "value required",
  ]);
  assert.ok(spinnerLog.some((entry) => entry === "message:authorizing"));
  assert.ok(
    spinnerLog.some((entry) => entry === "stop:complete Owner Subscription"),
  );

  const anonymous = await providerAuth.configureProviderAuth(
    "anonymous-subscription",
    "/tmp/provider-owner",
    {
      readJsonFile: (_path, fallback) => fallback,
      ensureNotCancelled: (value) => value,
      copy: copy as any,
      spinnerFactory: (() => fakeSpinner([])) as any,
      textPrompt: async (options: any) => {
        options.validate("value");
        return "value";
      },
      selectPrompt: async () => "device",
      async createAuthStorage() {
        return {
          hasAuth: () => false,
          getOAuthProviders: () => [{ id: "anonymous-subscription" }],
          async login(_provider: string, callbacks: any) {
            callbacks.onDeviceCode({
              userCode: "CODE",
              verificationUri: "https://login.example/device",
            });
            await callbacks.onPrompt({ message: "Prompt" });
            callbacks.onProgress("");
            await callbacks.onSelect({
              message: "Select",
              options: [{ id: "device", label: "Device" }],
            });
            await callbacks.onManualCodeInput();
          },
        };
      },
    },
  );
  assert.deepEqual(anonymous.authData, {});
  assert.equal(anonymous.authKind, "oauth");
});

test("provider auth reports OAuth failure and saves API keys", async () => {
  await assert.rejects(
    () =>
      providerAuth.configureProviderAuth(
        "broken-oauth",
        "/tmp/provider-owner",
        {
          readJsonFile: (_path, fallback) => fallback,
          ensureNotCancelled: (value) => value,
          copy: copy as any,
          async createAuthStorage() {
            return {
              hasAuth: () => false,
              getOAuthProviders: () => [{ id: "broken-oauth" }],
              async login() {
                throw new Error("oauth rejected");
              },
            };
          },
        },
      ),
    /oauth rejected/,
  );
  const saved: Record<string, unknown> = {};
  let blankValidation: string | undefined;
  const apiResult = await providerAuth.configureProviderAuth(
    "api-owner",
    "/tmp/provider-owner",
    {
      readJsonFile: (_path, fallback) => fallback,
      ensureNotCancelled: (value) => value,
      async textPrompt(options: any) {
        blankValidation = options.validate("  ");
        assert.equal(options.validate("already-present"), undefined);
        return "  secret-value  ";
      },
      async createAuthStorage() {
        return {
          hasAuth: () => false,
          getOAuthProviders: () => null,
          set(name: string, value: unknown) {
            saved[name] = value;
          },
          getAll: () => saved,
        };
      },
    },
  );
  assert.equal(blankValidation, "A token is required.");
  assert.deepEqual(saved, {
    "api-owner": { type: "api_key", key: "secret-value" },
  });
  assert.equal(apiResult.authKind, "api_key");
  assert.equal(apiResult.available, true);

  const apiWithoutSnapshot = await providerAuth.configureProviderAuth(
    "api-without-snapshot",
    "/tmp/provider-owner",
    {
      readJsonFile: (_path, fallback) => fallback,
      ensureNotCancelled: (value) => value,
      copy: copy as any,
      textPrompt: async () => "token",
      async createAuthStorage() {
        return {
          hasAuth: () => false,
          getOAuthProviders: () => undefined,
          set() {},
        };
      },
    },
  );
  assert.deepEqual(apiWithoutSnapshot.authData, {});
});
