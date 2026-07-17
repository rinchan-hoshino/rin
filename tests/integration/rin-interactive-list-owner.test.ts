import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const interactive = await importBuiltModule<
  typeof import("../../src/core/rin/interactive-list.js")
>("dist/core/rin/interactive-list.js");

class TestInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawModes: boolean[] = [];
  resumed = false;

  setRawMode(value: boolean) {
    this.isRaw = value;
    this.rawModes.push(value);
  }

  resume() {
    this.resumed = true;
    return this;
  }
}

class TestOutput {
  isTTY = true;
  writes: string[] = [];

  write(value: string) {
    this.writes.push(value);
    return true;
  }
}

test("interactive list declines non-terminal streams without rendering", async () => {
  let rendered = false;
  const opened = await interactive.runInteractiveList({
    intervalMs: 1,
    input: { isTTY: false } as NodeJS.ReadStream,
    output: { isTTY: true } as NodeJS.WriteStream,
    async render() {
      rendered = true;
      return { content: "unused", itemCount: 0 };
    },
  });

  assert.equal(opened, false);
  assert.equal(rendered, false);
});

test("interactive list applies navigation, expansion, and terminal cleanup", async () => {
  const input = new TestInput();
  const output = new TestOutput();
  const keys: Array<string | Buffer> = [
    "j",
    "\u001b[B",
    Buffer.from("\u001b[A"),
    "k",
    "\u001b[6~",
    "\u001b[5~",
    "\u001b[F",
    "\u001b[4~",
    "\u001b[H",
    "\u001b[1~",
    " ",
    "\u001b",
    "x",
    "Q",
  ];
  const states: Array<{ selectedIndex: number; expanded: boolean }> = [];
  let renderCount = 0;

  const opened = await interactive.runInteractiveList({
    intervalMs: 2,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    async render(state) {
      states.push({ ...state });
      const key = keys[renderCount];
      const itemCount = renderCount === 0 ? 12.9 : 12;
      renderCount += 1;
      queueMicrotask(() => input.emit("data", key));
      return { content: `frame:${renderCount}`, itemCount };
    },
  });

  assert.equal(opened, true);
  assert.equal(input.resumed, true);
  assert.deepEqual(input.rawModes, [true, false]);
  assert.ok(states.some((state) => state.selectedIndex === 11));
  assert.ok(states.some((state) => state.selectedIndex === 0));
  assert.ok(states.some((state) => state.expanded));
  assert.equal(states.at(-1)?.expanded, false);
  assert.equal(input.listenerCount("data"), 0);
  assert.equal(output.writes[0], "\u001b[?1049h\u001b[?25l");
  assert.equal(output.writes.at(-1), "\u001b[?25h\u001b[?1049l");
  assert.ok(
    output.writes.some((value) => value.includes("\u001b[2J\u001b[Hframe:")),
  );
});

test("interactive list preserves an already-raw input mode", async () => {
  const input = new TestInput();
  input.isRaw = true;
  const output = new TestOutput();

  await interactive.runInteractiveList({
    intervalMs: 1,
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
    async render() {
      queueMicrotask(() => input.emit("data", "\u0003"));
      return { content: "done", itemCount: Number.NaN };
    },
  });

  assert.deepEqual(input.rawModes, [true]);
});
