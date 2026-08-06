import assert from "node:assert/strict";
import test from "node:test";

import { initializePiInteractiveModeWithoutManagedToolEnsure } from "../../src/core/pi/tui-patches/index.js";

test("Rin TUI startup override does not call Pi managed-tool ensure", async () => {
  const calls: string[] = [];
  const instance: any = {
    isInitialized: false,
    registerSignalHandlers: () => calls.push("signals"),
    getChangelogForDisplay: () => "",
    fdPath: "unset",
    session: { scopedModels: [] },
    options: {},
    settingsManager: { getQuietStartup: () => true },
    ui: {
      addChild: (child: unknown) => calls.push(`add:${String(child)}`),
      setFocus: () => calls.push("focus"),
      start: () => calls.push("start"),
      invalidate: () => {},
      requestRender: () => {},
    },
    headerContainer: { addChild: () => calls.push("header") },
    loadedResourcesContainer: "resources",
    chatContainer: "chat",
    pendingMessagesContainer: "pending",
    statusContainer: "status",
    widgetContainerAbove: "above",
    widgetContainerBelow: "below",
    editorContainer: "editor-container",
    footer: "footer",
    editor: "editor",
    renderWidgets: () => calls.push("widgets"),
    setupKeyHandlers: () => calls.push("keys"),
    setupEditorSubmitHandler: () => calls.push("submit"),
    rebindCurrentSession: async () => calls.push("rebind"),
    renderInitialMessages: () => calls.push("initial"),
    footerDataProvider: { onBranchChange: () => calls.push("branch-watch") },
    updateAvailableProviderCount: async () => calls.push("providers"),
  };

  await initializePiInteractiveModeWithoutManagedToolEnsure(instance);

  assert.equal(instance.isInitialized, true);
  assert.notEqual(instance.fdPath, "unset");
  assert.deepEqual(calls, [
    "signals",
    "add:[object Object]",
    "add:resources",
    "header",
    "add:chat",
    "add:pending",
    "add:status",
    "widgets",
    "add:above",
    "add:editor-container",
    "add:below",
    "add:footer",
    "focus",
    "keys",
    "submit",
    "start",
    "rebind",
    "initial",
    "branch-watch",
    "providers",
  ]);
});
