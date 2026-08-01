import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  RIN_FRONTEND_SESSION_NOT_CONNECTED,
  RinFrontendSessionNotConnectedError,
  isRinFrontendSessionNotConnectedError,
} from "../../dist/core/rin-frontend-sdk/index.js";

const rootDir = path.resolve(import.meta.dirname, "../..");

test("frontend session disconnection has a typed transport contract", () => {
  const error = new RinFrontendSessionNotConnectedError();

  assert.equal(error.code, RIN_FRONTEND_SESSION_NOT_CONNECTED);
  assert.equal(error.message, RIN_FRONTEND_SESSION_NOT_CONNECTED);
  assert.equal(isRinFrontendSessionNotConnectedError(error), true);
  assert.equal(
    isRinFrontendSessionNotConnectedError({
      code: RIN_FRONTEND_SESSION_NOT_CONNECTED,
    }),
    true,
  );
  assert.equal(
    isRinFrontendSessionNotConnectedError(
      new Error(RIN_FRONTEND_SESSION_NOT_CONNECTED),
    ),
    false,
  );
});

test("Chat transport does not infer session disconnection from an error string", () => {
  const main = readFileSync(
    path.join(rootDir, "src/core/chat/main.ts"),
    "utf8",
  );
  const driver = readFileSync(
    path.join(rootDir, "src/core/rin-frontend-sdk/turn-driver.ts"),
    "utf8",
  );

  assert.doesNotMatch(main, /"frontend_session_not_connected"/);
  assert.doesNotMatch(driver, /new Error\("frontend_session_not_connected"\)/);
  assert.match(driver, /new RinFrontendSessionNotConnectedError\(\)/);
});
