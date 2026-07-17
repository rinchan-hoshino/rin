import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const loader = await importBuiltModule<
  typeof import("../../src/core/rin-lib/loader.js")
>("dist/core/rin-lib/loader.js");

test("Rin lazy loader returns the canonical Pi and Rin adapter exports", async () => {
  const firstSessionManager = await loader.loadRinSessionManagerModule();
  const firstInteractiveMode = await loader.loadRinInteractiveModeModule();
  const firstFooter = await loader.loadRinInteractiveFooterModule();
  const firstTheme = await loader.loadRinInteractiveThemeModule();
  const firstSelector = await loader.loadRinSessionSelectorModule();
  const firstChangelog = await loader.loadRinChangelogModule();

  const pi = await import("@earendil-works/pi-coding-agent");
  const privateApi = await importBuiltModule<
    typeof import("../../src/core/pi/private-api.js")
  >("dist/core/pi/private-api.js");
  const changelog = await importBuiltModule<
    typeof import("../../src/core/rin-lib/changelog.js")
  >("dist/core/rin-lib/changelog.js");

  assert.equal(firstSessionManager.SessionManager, pi.SessionManager);
  assert.equal(firstInteractiveMode.InteractiveMode, pi.InteractiveMode);
  assert.equal(firstFooter.FooterComponent, pi.FooterComponent);
  assert.deepEqual(firstTheme, {
    theme: privateApi.theme,
    initTheme: privateApi.initTheme,
  });
  assert.equal(
    firstSelector.SessionSelectorComponent,
    pi.SessionSelectorComponent,
  );
  assert.equal(firstChangelog.parseChangelog, changelog.parseChangelog);
  assert.equal(
    (await loader.loadRinSessionManagerModule()).SessionManager,
    pi.SessionManager,
  );
  assert.equal(
    (await loader.loadRinInteractiveModeModule()).InteractiveMode,
    pi.InteractiveMode,
  );
  assert.equal(
    (await loader.loadRinInteractiveFooterModule()).FooterComponent,
    pi.FooterComponent,
  );
  assert.equal(
    (await loader.loadRinSessionSelectorModule()).SessionSelectorComponent,
    pi.SessionSelectorComponent,
  );
  assert.deepEqual(await loader.loadRinInteractiveThemeModule(), {
    theme: privateApi.theme,
    initTheme: privateApi.initTheme,
  });
  assert.equal(
    (await loader.loadRinChangelogModule()).parseChangelog,
    changelog.parseChangelog,
  );
});
