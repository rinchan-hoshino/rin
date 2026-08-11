export const RIN_TUI_RUNTIME_ROLES = [
  "rpc-frontend",
  "maintenance-tui",
  "agent-runtime",
] as const;

export type RinTuiRuntimeRole = (typeof RIN_TUI_RUNTIME_ROLES)[number];

export const RIN_TUI_RPC_FRONTEND_ROLE = "rpc-frontend";
export const RIN_TUI_MAINTENANCE_ROLE = "maintenance-tui";
export const RIN_TUI_AGENT_RUNTIME_ROLE = "agent-runtime";
export const RIN_TUI_RUNTIME_ROLE_ENV = "RIN_TUI_RUNTIME_ROLE";
export const RIN_TUI_MAINTENANCE_REQUESTED_ENV =
  "RIN_TUI_MAINTENANCE_REQUESTED";

let currentRinTuiRuntimeRole: RinTuiRuntimeRole | undefined;

export function setRinTuiRuntimeRole(role: RinTuiRuntimeRole | undefined) {
  currentRinTuiRuntimeRole = role;
}

export function getRinTuiRuntimeRole() {
  return currentRinTuiRuntimeRole;
}
