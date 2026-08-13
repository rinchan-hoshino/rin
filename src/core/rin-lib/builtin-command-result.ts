export type BuiltinCommandName =
  | "abort"
  | "session"
  | "resume"
  | "changelog"
  | "new"
  | "compact"
  | "model"
  | "reload";

export type BuiltinCommandDataByName = {
  abort: Record<string, never>;
  session: { stats: unknown };
  resume:
    | { sessions: Array<{ id: string; name: string }> }
    | { resumedSessionId: string; cancelled: boolean };
  changelog: { entries: string[] };
  new: { cancelled: boolean };
  compact: Record<string, never>;
  model:
    | { models: string[] }
    | { selectedModel: string; thinkingLevel: string };
  reload: Record<string, never>;
};

export type BuiltinCommandResult = {
  [Name in BuiltinCommandName]: {
    handled: true;
    command: Name;
    data: BuiltinCommandDataByName[Name];
  };
}[BuiltinCommandName];

export function builtinCommandResult<Name extends BuiltinCommandName>(
  command: Name,
  data: BuiltinCommandDataByName[Name],
): Extract<BuiltinCommandResult, { command: Name }> {
  return { handled: true, command, data } as Extract<
    BuiltinCommandResult,
    { command: Name }
  >;
}
