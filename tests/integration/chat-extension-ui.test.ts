import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const rootDir = process.cwd();
const ui = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "chat", "extension-ui.js"))
    .href
);

test("chat extension UI renders notifications without a response", () => {
  assert.deepEqual(
    ui.projectChatExtensionUiRequest({
      type: "extension_ui_request",
      method: "notify",
      message: "Done",
    }),
    { text: "Done" },
  );
  assert.deepEqual(
    ui.projectChatExtensionUiRequest({
      type: "extension_ui_request",
      method: "notify",
      title: "Fallback title",
    }),
    { text: "Fallback title" },
  );
  assert.deepEqual(
    ui.projectChatExtensionUiRequest({
      type: "extension_ui_request",
      method: "notify",
      message: "   ",
    }),
    {},
  );
  assert.deepEqual(
    ui.projectChatExtensionUiRequest({
      type: "extension_ui_request",
      method: "notify",
    }),
    {},
  );
});

test("chat extension UI cancels unsupported dialogs instead of hanging", () => {
  assert.deepEqual(
    ui.projectChatExtensionUiRequest({
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      message: "Continue?",
    }),
    {
      text: 'Extension UI "confirm" is not supported in chat.',
      response: {
        type: "extension_ui_response",
        id: "ui-1",
        cancelled: true,
      },
    },
  );
  assert.deepEqual(
    ui.projectChatExtensionUiRequest({
      type: "extension_ui_request",
      method: "select",
      options: ["one"],
    }),
    { text: 'Extension UI "select" is not supported in chat.' },
  );
});
