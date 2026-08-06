import assert from "node:assert/strict";
import test from "node:test";

import { importBuiltModule } from "../support/import-built-module.js";

const runtimeEnv = await importBuiltModule<{
  RIN_TUI_RUNTIME_ROLES: readonly string[];
  RIN_TUI_RPC_FRONTEND_ROLE: string;
  RIN_TUI_MAINTENANCE_ROLE: string;
  RIN_TUI_AGENT_RUNTIME_ROLE: string;
  setRinTuiRuntimeRole(role: string | undefined): void;
  getRinTuiRuntimeRole(): string | undefined;
}>("dist/core/tui-runtime-env.js");

test("TUI runtime role state uses only the declared roles", () => {
  assert.deepEqual(runtimeEnv.RIN_TUI_RUNTIME_ROLES, [
    runtimeEnv.RIN_TUI_RPC_FRONTEND_ROLE,
    runtimeEnv.RIN_TUI_MAINTENANCE_ROLE,
    runtimeEnv.RIN_TUI_AGENT_RUNTIME_ROLE,
  ]);
  for (const role of runtimeEnv.RIN_TUI_RUNTIME_ROLES) {
    runtimeEnv.setRinTuiRuntimeRole(role);
    assert.equal(runtimeEnv.getRinTuiRuntimeRole(), role);
  }
  runtimeEnv.setRinTuiRuntimeRole(undefined);
  assert.equal(runtimeEnv.getRinTuiRuntimeRole(), undefined);
});
