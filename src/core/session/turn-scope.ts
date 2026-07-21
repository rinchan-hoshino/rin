export type RinTurnScope = {
  sessionManager: any;
  baselineLeafId: string | null;
};

export const TURN_SCOPE_UNAVAILABLE_ERROR =
  "Rin session branch cursor is unavailable before the turn starts.";
export const TURN_SCOPE_CHANGED_ERROR =
  "Rin session branch ownership changed while the turn was running.";

function sessionEntryId(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function captureTurnScope(session: any): RinTurnScope {
  const sessionManager = session?.sessionManager;
  if (
    typeof sessionManager?.getBranch !== "function" ||
    typeof sessionManager?.getLeafId !== "function"
  ) {
    throw new Error(TURN_SCOPE_UNAVAILABLE_ERROR);
  }
  const branch = sessionManager.getBranch();
  if (!Array.isArray(branch)) {
    throw new Error(TURN_SCOPE_UNAVAILABLE_ERROR);
  }
  const rawManagerLeafId = sessionManager.getLeafId();
  const managerLeafId = sessionEntryId(rawManagerLeafId);
  if (rawManagerLeafId != null && !managerLeafId) {
    throw new Error(TURN_SCOPE_UNAVAILABLE_ERROR);
  }
  if (branch.length === 0) {
    if (managerLeafId) throw new Error(TURN_SCOPE_UNAVAILABLE_ERROR);
    return { sessionManager, baselineLeafId: null };
  }
  const branchLeafId = sessionEntryId(branch.at(-1)?.id);
  if (!branchLeafId || managerLeafId !== branchLeafId) {
    throw new Error(TURN_SCOPE_UNAVAILABLE_ERROR);
  }
  return { sessionManager, baselineLeafId: branchLeafId };
}

export function readTurnMessages(session: any, scope: RinTurnScope) {
  if (session?.sessionManager !== scope.sessionManager) {
    throw new Error(TURN_SCOPE_CHANGED_ERROR);
  }
  const branch = scope.sessionManager.getBranch?.();
  if (
    !Array.isArray(branch) ||
    typeof scope.sessionManager.getLeafId !== "function"
  ) {
    throw new Error(TURN_SCOPE_CHANGED_ERROR);
  }
  const rawManagerLeafId = scope.sessionManager.getLeafId();
  const managerLeafId = sessionEntryId(rawManagerLeafId);
  if (rawManagerLeafId != null && !managerLeafId) {
    throw new Error(TURN_SCOPE_CHANGED_ERROR);
  }
  if (branch.length === 0) {
    if (managerLeafId || scope.baselineLeafId) {
      throw new Error(TURN_SCOPE_CHANGED_ERROR);
    }
  } else {
    const branchLeafId = sessionEntryId(branch.at(-1)?.id);
    if (!branchLeafId || managerLeafId !== branchLeafId) {
      throw new Error(TURN_SCOPE_CHANGED_ERROR);
    }
  }

  let turnEntries = branch;
  if (scope.baselineLeafId) {
    const cursorIndex = branch.findIndex(
      (entry: any) => sessionEntryId(entry?.id) === scope.baselineLeafId,
    );
    if (cursorIndex < 0) throw new Error(TURN_SCOPE_CHANGED_ERROR);
    turnEntries = branch.slice(cursorIndex + 1);
  }
  return turnEntries
    .filter((entry: any) => entry?.type === "message")
    .map((entry: any) => entry.message)
    .filter(Boolean);
}
