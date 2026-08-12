export const DEFAULT_SELF_IMPROVE_TURN_WINDOW_TURNS = 8;

export function normalizeSelfImproveTurnWindowTurns(value: unknown) {
  const turns = Number(value);
  if (!Number.isFinite(turns) || turns <= 0) {
    return DEFAULT_SELF_IMPROVE_TURN_WINDOW_TURNS;
  }
  return Math.floor(turns);
}
