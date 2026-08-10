import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const confirmation = await importBuiltModule(
  "dist/core/rin-install/update-confirmation.js",
);

test("update confirmation accepts interactive or explicitly confirmed calls", () => {
  assert.doesNotThrow(() =>
    confirmation.assertUpdateConfirmationAvailable({
      assumeYes: false,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    }),
  );
  assert.doesNotThrow(() =>
    confirmation.assertUpdateConfirmationAvailable({
      assumeYes: true,
      stdinIsTTY: false,
      stdoutIsTTY: false,
    }),
  );
});

test("update confirmation rejects either non-interactive stream without --yes", () => {
  for (const context of [
    { assumeYes: false, stdinIsTTY: false, stdoutIsTTY: true },
    { assumeYes: false, stdinIsTTY: true, stdoutIsTTY: false },
  ]) {
    assert.throws(
      () => confirmation.assertUpdateConfirmationAvailable(context),
      /rin_update_confirmation_required: pass --yes in non-interactive mode/,
    );
  }
});
