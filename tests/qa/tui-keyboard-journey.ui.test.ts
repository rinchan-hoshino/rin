import assert from "node:assert/strict";
import test from "node:test";

import { runUiOnlyTuiJourney } from "../support/install-to-tui-harness.js";

test("UI-only: a user opens keyboard help and quits from the installed TUI", async () => {
  const journey = await runUiOnlyTuiJourney();

  assert.match(journey.startupScreen, /Rin can explain its own features/);
  assert.match(journey.hotkeysScreen, /Keyboard Shortcuts/);
  assert.match(journey.hotkeysScreen, /Slash commands/);
  assert.equal(journey.exit.code, 0, journey.finalScreen);
  assert.doesNotMatch(
    journey.finalScreen,
    /Rin fatal error|TypeError|MODULE_NOT_FOUND|Cannot find module/,
  );
});
