import { safeString } from "../text-utils.js";

export type RinTodoItem = {
  id: number;
  text: string;
  done: boolean;
};

export type RinTodoSnapshot = {
  todos: RinTodoItem[];
  nextId?: number;
  pendingCount: number;
  signature: string;
};

export type TodoFinalContinuationResult = {
  continuations: number;
  reason:
    | "no_pending"
    | "completed"
    | "unchanged"
    | "max_turns"
    | "prompt_error";
  snapshot: RinTodoSnapshot;
  errorMessage?: string;
};

export const TODO_FINAL_CONTINUATION_MAX_TURNS = 64;

function normalizeTodoItem(value: unknown): RinTodoItem | undefined {
  const item = value && typeof value === "object" ? (value as any) : null;
  if (!item) return undefined;
  const id = Number(item.id);
  const text = safeString(item.text).trim();
  if (!Number.isSafeInteger(id) || id <= 0 || !text) return undefined;
  return {
    id,
    text,
    done: Boolean(item.done),
  };
}

function todoSnapshot(todos: RinTodoItem[] = [], nextId?: number) {
  const normalized = todos
    .map((todo) => ({ ...todo }))
    .sort((left, right) => left.id - right.id);
  return {
    todos: normalized,
    nextId,
    pendingCount: normalized.filter((todo) => !todo.done).length,
    signature: JSON.stringify({ todos: normalized, nextId }),
  } satisfies RinTodoSnapshot;
}

function messageFromEntry(entry: unknown) {
  const value = entry && typeof entry === "object" ? (entry as any) : null;
  if (!value) return undefined;
  if (value.type === "message") return value.message;
  return value;
}

function todoSnapshotFromMessage(
  message: unknown,
): RinTodoSnapshot | undefined {
  const value =
    message && typeof message === "object" ? (message as any) : null;
  if (!value) return undefined;
  if (safeString(value.role).trim() !== "toolResult") return undefined;
  if (safeString(value.toolName).trim() !== "todo") return undefined;
  const details =
    value.details && typeof value.details === "object"
      ? value.details
      : undefined;
  const todos = Array.isArray((details as any)?.todos)
    ? (details as any).todos.map(normalizeTodoItem).filter(Boolean)
    : undefined;
  if (!todos) return undefined;
  const rawNextId = Number((details as any)?.nextId);
  return todoSnapshot(
    todos,
    Number.isSafeInteger(rawNextId) && rawNextId > 0 ? rawNextId : undefined,
  );
}

function branchEntriesFromSession(session: any) {
  const branch = session?.sessionManager?.getBranch?.();
  if (Array.isArray(branch)) return branch;
  const messages = session?.agent?.state?.messages;
  if (Array.isArray(messages)) return messages;
  return [];
}

export function readTodoSnapshotFromSession(session: any): RinTodoSnapshot {
  let latest: RinTodoSnapshot = todoSnapshot();
  for (const entry of branchEntriesFromSession(session)) {
    const next = todoSnapshotFromMessage(messageFromEntry(entry));
    if (next) latest = next;
  }
  return latest;
}

function formatPendingTodos(snapshot: RinTodoSnapshot) {
  return snapshot.todos
    .filter((todo) => !todo.done)
    .map((todo) => `- #${todo.id}: ${todo.text}`)
    .join("\n");
}

export function buildTodoFinalContinuationPrompt(snapshot: RinTodoSnapshot) {
  const pending =
    formatPendingTodos(snapshot) || "- unfinished todo items exist";
  return [
    "Hidden runtime continuation: your previous final answer is being withheld because the session todo list still has unfinished items.",
    "Continue the task now and update the todo list as you work.",
    "Do not give a final answer until the todo list is complete, or until you have made the required progress and are genuinely blocked by missing user input or authority.",
    "If blocked, make the blocker clear in the next final answer without marking unfinished work as done.",
    "",
    "Unfinished todo items:",
    pending,
  ].join("\n");
}

export async function continueTodoFinalIfNeeded(
  session: any,
  options: {
    maxContinuations?: number;
    waitForEvents?: () => Promise<void> | void;
  } = {},
): Promise<TodoFinalContinuationResult> {
  const maxContinuations = Math.max(
    0,
    Math.floor(
      Number(options.maxContinuations ?? TODO_FINAL_CONTINUATION_MAX_TURNS),
    ),
  );
  let snapshot = readTodoSnapshotFromSession(session);
  if (snapshot.pendingCount <= 0) {
    return { continuations: 0, reason: "no_pending", snapshot };
  }

  let continuations = 0;
  while (continuations < maxContinuations) {
    const previousSignature = snapshot.signature;
    try {
      await session.prompt(buildTodoFinalContinuationPrompt(snapshot), {
        expandPromptTemplates: false,
        source: "builtin:todo-continuation",
      });
      continuations += 1;
      await options.waitForEvents?.();
    } catch (error: any) {
      return {
        continuations,
        reason: "prompt_error",
        snapshot,
        errorMessage: safeString(error?.message || error).trim(),
      };
    }

    snapshot = readTodoSnapshotFromSession(session);
    if (snapshot.pendingCount <= 0) {
      return { continuations, reason: "completed", snapshot };
    }
    if (snapshot.signature === previousSignature) {
      return { continuations, reason: "unchanged", snapshot };
    }
  }

  return { continuations, reason: "max_turns", snapshot };
}
