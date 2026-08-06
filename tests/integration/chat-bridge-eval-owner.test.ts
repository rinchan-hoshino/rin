import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const bridgeEval = await importBuiltModule<
  typeof import("../../src/core/chat-bridge/eval.js")
>("dist/core/chat-bridge/eval.js");

test("chat bridge evaluation clamps execution budgets", () => {
  assert.equal(bridgeEval.clampChatBridgeTimeoutMs(undefined), 10_000);
  assert.equal(bridgeEval.clampChatBridgeTimeoutMs(-1), 10_000);
  assert.equal(bridgeEval.clampChatBridgeTimeoutMs(1.6), 2);
  assert.equal(bridgeEval.clampChatBridgeTimeoutMs(999_999), 120_000);
});

test("chat bridge evaluation serializes supported values with finite output", () => {
  const circular: Record<string, unknown> = { label: "root" };
  circular.self = circular;
  const longArray = Array.from({ length: 105 }, (_, index) => index);
  const longObject = Object.fromEntries(
    Array.from({ length: 105 }, (_, index) => [`key${index}`, index]),
  );
  const caused = new Error("outer", { cause: new Error("inner") });

  assert.deepEqual(bridgeEval.serializeBridgeValue(Buffer.from("hello")), {
    type: "Buffer",
    length: 5,
    preview: "hello",
  });
  assert.deepEqual(bridgeEval.serializeBridgeValue(new Map([["key", 1n]])), {
    type: "Map",
    entries: [["key", "1"]],
  });
  assert.deepEqual(bridgeEval.serializeBridgeValue(new Set([true, false])), {
    type: "Set",
    values: [true, false],
  });
  assert.equal(
    (bridgeEval.serializeBridgeValue(circular) as any).self,
    "[Circular]",
  );
  assert.match(
    String((bridgeEval.serializeBridgeValue(longArray) as unknown[]).at(-1)),
    /5 more items/,
  );
  assert.equal(
    (bridgeEval.serializeBridgeValue(longObject) as any).__truncatedKeys,
    5,
  );
  assert.equal(
    (bridgeEval.serializeBridgeValue(caused) as any).cause.message,
    "inner",
  );
  assert.equal(
    bridgeEval.serializeBridgeValue(new Date(0)),
    new Date(0).toISOString(),
  );
  assert.equal(
    bridgeEval.serializeBridgeValue(function demo() {}),
    "[Function demo]",
  );
  assert.equal(bridgeEval.serializeBridgeValue(Symbol("demo")), "Symbol(demo)");
  assert.match(
    String(bridgeEval.serializeBridgeValue("x".repeat(5_000))),
    /more chars/,
  );
  const anonymous = Function("return function () {}")();
  assert.equal(
    bridgeEval.serializeBridgeValue(anonymous),
    "[Function anonymous]",
  );
  const namelessError = Object.assign(new Error(""), { name: "" });
  assert.equal(
    (bridgeEval.serializeBridgeValue(namelessError) as any).message,
    "unknown_error",
  );
  const deep = bridgeEval.serializeBridgeValue({
    a: { b: { c: { d: { e: { f: { g: 1 } } } } } },
  }) as any;
  assert.equal(deep.a.b.c.d.e.f, "[MaxDepth]");
});

test("chat bridge evaluation transpiles TypeScript and executes in a bounded context", async () => {
  const transpiled = await bridgeEval.transpileChatBridgeCode(
    "const value: number = input + 1; return { value };",
  );
  assert.match(transpiled, /__chat_bridge__/);
  assert.doesNotMatch(transpiled, /: number/);

  const result = await bridgeEval.executeChatBridgeCode({
    code: "const value: number = input + 1; return { value, missing: undefined };",
    context: { input: 4 },
    timeoutMs: 250,
    filename: "owner-eval.ts",
  });
  assert.equal(result.timeoutMs, 250);
  assert.deepEqual(result.value, { value: 5, missing: null });
  assert.match(result.text, /"value": 5/);

  const raw = await bridgeEval.executeChatBridgeCode({
    code: "return 'plain text';",
    context: {},
  });
  assert.equal(raw.text, "plain text");
});

test("chat bridge evaluation reports syntax, sandbox, and async timeout failures", async () => {
  await assert.rejects(
    bridgeEval.transpileChatBridgeCode("const value: = 1;"),
    /chat_bridge_transpile_failed/,
  );
  await assert.rejects(
    bridgeEval.executeChatBridgeCode({
      code: "return Function('return 1')();",
      context: {},
      timeoutMs: 50,
    }),
    /Code generation from strings disallowed|EvalError/,
  );
  await assert.rejects(
    bridgeEval.executeChatBridgeCode({
      code: "return await new Promise(() => {});",
      context: { Promise },
      timeoutMs: 5,
    }),
    /chat_bridge_timeout:5/,
  );
});

test("chat bridge result rendering handles undefined and truncates huge output", () => {
  assert.equal(bridgeEval.renderChatBridgeResult(undefined), "undefined");
  assert.equal(bridgeEval.renderChatBridgeResult("ready"), "ready");
  assert.match(
    bridgeEval.renderChatBridgeResult({ output: "x".repeat(25_000) }),
    /output truncated/,
  );
});
