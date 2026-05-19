import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
);
const sdk = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "rin-frontend-sdk", "index.js"),
  ).href
);

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
  ]);
});
