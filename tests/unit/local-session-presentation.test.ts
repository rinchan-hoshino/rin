import "../support/require-test-sandbox.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { importBuiltModule } from "../support/import-built-module.js";

const presentation = await importBuiltModule<
  typeof import("../../src/core/rin-tui/local-session-presentation.js")
>("dist/core/rin-tui/local-session-presentation.js");
const renderers = await importBuiltModule<
  typeof import("../../src/core/rin-tui/tool-renderers/index.js")
>("dist/core/rin-tui/tool-renderers/index.js");

test("local TUI adds presentation without changing core execution ownership", () => {
  const nativeTodo = {
    name: "todo",
    execute() {},
    parameters: { type: "object" },
  };
  const extensionCommands = [{ name: "owner", handler() {} }];
  const runner: any = {
    getRegisteredCommands: () => extensionCommands,
    getCommand: (name: string) =>
      extensionCommands.find((command) => command.name === name),
  };
  const runtime: any = {
    session: {
      sessionManager: {},
      extensionRunner: runner,
      getToolDefinition: (name: string) =>
        name === "todo"
          ? nativeTodo
          : name === "owner"
            ? { name: "owner", execute() {} }
            : undefined,
    },
  };

  presentation.attachLocalTuiPresentation(runtime);
  presentation.attachLocalTuiPresentation(runtime);
  const todo = runtime.session.getToolDefinition("todo");
  assert.equal(todo.execute, nativeTodo.execute);
  assert.equal(todo.parameters, nativeTodo.parameters);
  assert.equal(
    todo.renderCall,
    renderers.getCoreToolRenderer("todo")?.renderCall,
  );
  assert.equal(
    todo.renderResult,
    renderers.getCoreToolRenderer("todo")?.renderResult,
  );
  assert.deepEqual(runner.getRegisteredCommands(), extensionCommands);
  assert.equal(runner.getCommand("todos"), undefined);
  assert.equal(runtime.session.getToolDefinition("owner").name, "owner");
  assert.equal(runtime.session.getToolDefinition("missing"), undefined);
  assert.equal(nativeTodo.renderCall, undefined);
});
