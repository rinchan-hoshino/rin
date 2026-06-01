export const RIN_SESSION_PRUNING_PROTECT_RECENT_TURNS = 4;
export const RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT =
  "[old tool result omitted to save context.]";

type SessionPruningOptions = {
  protectRecentTurns?: number;
};

function normalizeProtectRecentTurns(value: unknown) {
  const turns = Number(value);
  if (!Number.isFinite(turns) || turns <= 0) {
    return RIN_SESSION_PRUNING_PROTECT_RECENT_TURNS;
  }
  return Math.floor(turns);
}

function isUserMessage(message: any) {
  return String(message?.role || "").trim() === "user";
}

function isToolResultMessage(message: any) {
  const role = String(message?.role || "").trim();
  return role === "toolResult" || role === "tool_result";
}

function findProtectedContextStart(
  messages: any[],
  protectRecentTurns: number,
) {
  let turns = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!isUserMessage(messages[index])) continue;
    turns += 1;
    if (turns >= protectRecentTurns) return index;
  }
  return 0;
}

function isAlreadyOmitted(content: any) {
  if (typeof content === "string") {
    return content === RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT;
  }
  if (!Array.isArray(content) || content.length !== 1) return false;
  const item = content[0];
  return (
    item &&
    typeof item === "object" &&
    item.type === "text" &&
    item.text === RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT
  );
}

function omittedContentFor(content: any) {
  if (Array.isArray(content)) {
    return [{ type: "text", text: RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT }];
  }
  return RIN_SESSION_PRUNING_OMITTED_TOOL_RESULT;
}

export function pruneSessionContextMessages(
  messages: any[],
  options: SessionPruningOptions = {},
) {
  const list = Array.isArray(messages) ? messages : [];
  const protectedStart = findProtectedContextStart(
    list,
    normalizeProtectRecentTurns(options.protectRecentTurns),
  );
  let changed = false;
  const pruned = list.map((message, index) => {
    if (index >= protectedStart || !isToolResultMessage(message)) {
      return message;
    }
    if (isAlreadyOmitted(message?.content)) return message;
    changed = true;
    return { ...message, content: omittedContentFor(message?.content) };
  });
  return changed ? pruned : list;
}

export function pruneSessionContextEvent(
  event: any,
  options: SessionPruningOptions = {},
) {
  if (!Array.isArray(event?.messages)) return undefined;
  const messages = pruneSessionContextMessages(event.messages, options);
  if (messages === event.messages) return undefined;
  return { messages };
}
