import test from "node:test";
import assert from "node:assert/strict";
import { importBuiltModule } from "../support/import-built-module.js";

const sdk = await importBuiltModule<
  typeof import("../../src/core/rin-frontend-sdk/runtime-wrapper.js")
>("dist/core/rin-frontend-sdk/runtime-wrapper.js");

test("frontend SDK wrappers reject invalid values and preserve existing wrappers", () => {
  assert.equal(sdk.isFrontendSdkRuntimeWrapper(null), false);
  assert.equal(sdk.isFrontendSdkSessionWrapper(null), false);
  assert.equal(sdk.createFrontendSdkRuntimeWrapper(null as any), null);
  assert.equal(
    sdk.createFrontendSdkSessionWrapper(undefined as any),
    undefined,
  );

  const session = { [sdk.FRONTEND_SDK_SESSION_WRAPPER_KEY]: true };
  const runtime = { [sdk.FRONTEND_SDK_RUNTIME_WRAPPER_KEY]: true };
  assert.equal(sdk.createFrontendSdkSessionWrapper(session), session);
  assert.equal(sdk.createFrontendSdkRuntimeWrapper(runtime), runtime);
});

test("frontend SDK runtime wrapper binds methods and refreshes replaced sessions", () => {
  const firstSession = {
    value: 1,
    read() {
      return this.value;
    },
  };
  const runtime = {
    value: 2,
    session: firstSession as any,
    read() {
      return this.value;
    },
  };
  const wrapped = sdk.createFrontendSdkRuntimeWrapper(runtime);
  assert.equal(wrapped.read(), 2);
  assert.equal(wrapped.session.read(), 1);
  wrapped.session.value = 3;
  assert.equal(firstSession.value, 3);

  const firstWrapped = wrapped.session;
  wrapped.session = null;
  assert.equal(wrapped.session, null);
  wrapped.session = { value: 4 };
  assert.notEqual(wrapped.session, firstWrapped);
  assert.equal(wrapped.session.value, 4);
});

test("frontend SDK runtime wrapper keeps TUI prompt on the native session path", async () => {
  const calls: any[] = [];
  const nativeSession = {
    value: 1,
    async prompt(text: string, options: any = {}) {
      calls.push({ text, options, thisValue: this.value });
    },
  };
  const runtime = { session: nativeSession };

  const wrappedRuntime = sdk.createFrontendSdkRuntimeWrapper(runtime);

  assert.equal(sdk.isFrontendSdkRuntimeWrapper(wrappedRuntime), true);
  assert.equal(sdk.isFrontendSdkSessionWrapper(wrappedRuntime.session), true);
  assert.equal(wrappedRuntime.session, wrappedRuntime.session);
  await wrappedRuntime.session.prompt("hello", {
    images: [{ type: "image", image: "file:///tmp/a.png" }],
    streamingBehavior: "steer",
    source: "tui",
    requestTag: "tag-1",
    promptContext: { source: "tui" },
    sessionFile: "/tmp/session.jsonl",
    sessionId: "session-1",
  });

  await wrappedRuntime.session.prompt("defaults");

  assert.deepEqual(calls, [
    {
      text: "hello",
      options: {
        images: [{ type: "image", image: "file:///tmp/a.png" }],
        streamingBehavior: "steer",
        source: "tui",
        requestTag: "tag-1",
        promptContext: { source: "tui" },
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
      },
      thisValue: 1,
    },
    {
      text: "defaults",
      options: {
        images: undefined,
        streamingBehavior: undefined,
        source: undefined,
        requestTag: undefined,
      },
      thisValue: 1,
    },
  ]);
});
