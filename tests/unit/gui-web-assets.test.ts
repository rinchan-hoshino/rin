import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const gui = await importBuiltModule<{
  escapeHtml(value: unknown): string;
  parseRinGuiArgs(argv: string[]): Record<string, never>;
}>("dist/core/rin-gui/web-assets.js");

test("GUI HTML escaping covers every markup delimiter and nullish input", () => {
  assert.equal(gui.escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
  assert.equal(gui.escapeHtml(null), "");
  assert.equal(gui.escapeHtml(42), "42");
});

test("GUI arguments accept only the GUI marker and option terminator", () => {
  assert.deepEqual(gui.parseRinGuiArgs([]), {});
  assert.deepEqual(gui.parseRinGuiArgs(["", " gui ", "--", "ignored"]), {});
  assert.throws(
    () => gui.parseRinGuiArgs(["--unknown"]),
    /rin_gui_unrecognized_arg:--unknown/,
  );
});
