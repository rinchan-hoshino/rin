import "../support/require-test-sandbox.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

await import("../support/register-rpc-mode-owner-fixture.ts");

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("rpc mode owner cases complete in an isolated test-file runner", async () => {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  if (process.env.RIN_TEST_CONTAINER === "1") {
    childEnv.RIN_TEST_CONTAINER = "1";
  } else if (process.env.RIN_SYSTEM_TEST_CONTAINER_INNER === "1") {
    childEnv.RIN_SYSTEM_TEST_CONTAINER_INNER = "1";
  } else if (process.env.RIN_INSTALL_TUI_CONTAINER_INNER === "1") {
    childEnv.RIN_INSTALL_TUI_CONTAINER_INNER = "1";
  }
  const tempDir = await fs.mkdtemp(
    path.join(rootDir, "tests", "support", ".rpc-owner-wrapper-"),
  );
  const shimPath = path.join(tempDir, "rpc-mode-owner-cases.test.ts");
  await fs.writeFile(
    shimPath,
    `import ${JSON.stringify(
      pathToFileURL(
        path.join(
          rootDir,
          "tests",
          "support",
          "register-rpc-mode-owner-fixture.ts",
        ),
      ).href,
    )};\nimport ${JSON.stringify(
      pathToFileURL(
        path.join(rootDir, "tests", "support", "rpc-mode-owner-cases.ts"),
      ).href,
    )};\n`,
    "utf8",
  );
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(rootDir, "scripts", "test", "run-test-files.ts"),
          "--concurrency=1",
          path.relative(rootDir, shimPath),
        ],
        {
          cwd: rootDir,
          env: childEnv,
          timeout: 30_000,
          maxBuffer: 64 * 1024 * 1024,
        },
      ),
      (error: unknown) => {
        const failure = error as {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        const output = `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`;
        assert.equal(failure.code, 1);
        assert.match(output, /# pass [1-9]\d*/);
        assert.match(output, /# fail 1/);
        assert.doesNotMatch(output, /AssertionError/);
        return true;
      },
    );

    const ownerModule = (await import(
      pathToFileURL(
        path.join(rootDir, "dist", "core", "rin-daemon", "rpc-mode.js"),
      ).href
    )) as typeof import("../../src/core/rin-daemon/rpc-mode.js");
    let loginOptions: any;
    const notifications: string[] = [];
    const runtime = {
      async login(_providerId: string, _authType: string, options: any) {
        loginOptions = options;
        return "logged-in";
      },
      async refresh() {
        notifications.push("refresh");
      },
    };
    assert.equal(
      await ownerModule.loginSessionProvider(
        { modelRuntime: runtime },
        "owner",
        {
          authType: "api_key",
          signal: new AbortController().signal,
          onSelect: () => "selected",
          onManualCodeInput: () => "manual",
          onPrompt: () => "prompted",
          onAuth: () => notifications.push("auth"),
          onDeviceCode: () => notifications.push("device"),
          onInfo: () => notifications.push("info"),
          onProgress: (message: string) => notifications.push(message),
        },
      ),
      "logged-in",
    );
    assert.equal(await loginOptions.prompt({ type: "select" }), "selected");
    assert.equal(await loginOptions.prompt({ type: "manual_code" }), "manual");
    assert.equal(
      await loginOptions.prompt({
        type: "secret",
        message: "Owner key",
        placeholder: "key",
      }),
      "prompted",
    );
    loginOptions.notify({ type: "auth_url" });
    loginOptions.notify({ type: "device_code" });
    loginOptions.notify({ type: "info" });
    loginOptions.notify({ type: "progress", message: "progress" });
    loginOptions.notify({ type: "ignored" });
    assert.equal(
      await ownerModule.loginSessionProvider(
        { modelRuntime: runtime },
        "owner-oauth-fallback",
        {
          authType: "oauth",
          onSelect: () => "selected",
          onManualCodeInput: () => "manual",
          onPrompt: () => "prompted",
          onAuth: () => undefined,
          onDeviceCode: () => undefined,
          onInfo: () => undefined,
          onProgress: () => undefined,
        },
      ),
      "logged-in",
    );
    assert.equal(await loginOptions.prompt({ type: "select" }), "selected");
    assert.equal(
      await loginOptions.prompt({
        type: "select",
        signal: new AbortController().signal,
      }),
      "selected",
    );
    const callbackAbort = new AbortController();
    await ownerModule.loginSessionProvider(
      { modelRuntime: runtime },
      "owner-combined-signal",
      {
        authType: "api_key",
        signal: callbackAbort.signal,
        onSelect: () => "combined",
        onManualCodeInput: () => "manual",
        onPrompt: () => "prompted",
        onAuth: () => undefined,
        onDeviceCode: () => undefined,
        onInfo: () => undefined,
        onProgress: () => undefined,
      },
    );
    assert.equal(
      await loginOptions.prompt({
        type: "select",
        signal: new AbortController().signal,
      }),
      "combined",
    );
    assert.deepEqual(notifications.slice(0, 4), [
      "auth",
      "device",
      "info",
      "progress",
    ]);

    const oauthRuntime = {
      authStorage: {
        async login(providerId: string) {
          return `oauth:${providerId}`;
        },
      },
    };
    assert.equal(
      await ownerModule.loginSessionProvider(
        { modelRuntime: oauthRuntime },
        "owner-oauth",
        { authType: "oauth" },
      ),
      "oauth:owner-oauth",
    );
    const stored: unknown[] = [];
    await ownerModule.setSessionApiKey(
      {
        modelRuntime: {
          authStorage: {
            set(...args: unknown[]) {
              stored.push(args);
            },
          },
          refresh: async () => notifications.push("stored-refresh"),
        },
      },
      "owner-key",
      "secret",
    );
    assert.equal(stored.length, 1);
    const logoutEvents: string[] = [];
    const logoutProvider = (ownerModule as any).__rinOwnerLogoutSessionProvider;
    await logoutProvider(
      {
        modelRuntime: {
          authStorage: {
            async logout(providerId: string) {
              logoutEvents.push(`storage:${providerId}`);
            },
          },
          async refresh() {
            logoutEvents.push("storage-refresh");
          },
        },
      },
      "owner-storage",
    );
    await logoutProvider(
      {
        modelRuntime: {
          async logout(providerId: string) {
            logoutEvents.push(`runtime:${providerId}`);
          },
          async refresh() {
            logoutEvents.push("runtime-refresh");
          },
        },
      },
      "owner-runtime",
    );
    assert.deepEqual(logoutEvents, [
      "storage:owner-storage",
      "storage-refresh",
      "runtime:owner-runtime",
      "runtime-refresh",
    ]);
    await ownerModule.setSessionApiKey(
      {
        modelRuntime: {
          async login(_providerId: string, _authType: string, options: any) {
            assert.equal(
              await options.prompt({ type: "secret" }),
              "fallback-key",
            );
            await assert.rejects(
              () => options.prompt({ type: "secret" }),
              /interactive API-key setup/,
            );
          },
        },
      },
      "owner-fallback",
      "fallback-key",
    );
    await assert.rejects(
      () =>
        ownerModule.setSessionApiKey(
          {
            modelRuntime: {
              async login(
                _providerId: string,
                _authType: string,
                options: any,
              ) {
                await options.prompt({ type: "text" });
              },
            },
          },
          "owner-interactive",
          "unused",
        ),
      /interactive API-key setup/,
    );
    const login = { nextWaitSeq: 0 };
    assert.equal(
      ownerModule.nextOAuthLoginRequestId(login, "login", "prompt"),
      "login:prompt:1",
    );
    await new Promise<void>((resolve) => {
      ownerModule.deferOAuthLoginStart(resolve);
    });
    ownerModule.deferOAuthLoginStart(() => {
      throw new Error("ignored deferred failure");
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
