import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const lifecycle = await importBuiltModule<{
  RIN_FRONTEND_TURN_CANCELLED: string;
  createRinFrontendTurnCancelledError(): Error & { code?: string };
  isRinFrontendTurnCancelledError(error: unknown): boolean;
}>("dist/core/rin-frontend-sdk/lifecycle-errors.js");

test("frontend cancellation errors use one stable code and recognize transport aborts", () => {
  const error = lifecycle.createRinFrontendTurnCancelledError();
  assert.equal(error.message, lifecycle.RIN_FRONTEND_TURN_CANCELLED);
  assert.equal(error.code, lifecycle.RIN_FRONTEND_TURN_CANCELLED);
  for (const value of [
    error,
    { code: lifecycle.RIN_FRONTEND_TURN_CANCELLED },
    { message: ` ${lifecycle.RIN_FRONTEND_TURN_CANCELLED} ` },
    new Error("Request was aborted"),
  ]) {
    assert.equal(lifecycle.isRinFrontendTurnCancelledError(value), true);
  }
  for (const value of [undefined, null, "other", new Error("failed")]) {
    assert.equal(lifecycle.isRinFrontendTurnCancelledError(value), false);
  }
});
