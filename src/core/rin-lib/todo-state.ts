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

export const RIN_TODO_CUSTOM_ENTRY_TYPE = "rin.todo";

export function normalizeRinTodoItem(value: unknown): RinTodoItem | undefined {
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

export function normalizeRinTodoItems(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(normalizeRinTodoItem)
    .filter((todo): todo is RinTodoItem => Boolean(todo));
}

export function formatRinTodoItemText(todo: Pick<RinTodoItem, "text">) {
  return safeString(todo.text).trim();
}

function formatRinTodoLineText(todo: Pick<RinTodoItem, "text">) {
  return formatRinTodoItemText(todo).replace(/\s+/g, " ").trim();
}

export function formatRinTodoChecklistContent(
  todos: ReadonlyArray<Pick<RinTodoItem, "text" | "done">>,
): string {
  if (todos.length === 0) return "No todos";

  return todos
    .map((todo) => `[${todo.done ? "x" : " "}] ${formatRinTodoItemText(todo)}`)
    .join("\n");
}

export function formatRinTodoChecklistMarkdownContent(
  todos: ReadonlyArray<Pick<RinTodoItem, "text" | "done">>,
): string {
  if (todos.length === 0) return "No todos";

  return todos
    .map((todo) => {
      const text = formatRinTodoLineText(todo);
      return `${todo.done ? "☑" : "☐"} ${todo.done ? `~~${text}~~` : text}`;
    })
    .join("\n");
}

export function formatRinTodoChecklistCharacterContent(
  todos: ReadonlyArray<Pick<RinTodoItem, "text" | "done">>,
): string {
  if (todos.length === 0) return "No todos";

  return todos
    .map((todo) => {
      const text = formatRinTodoLineText(todo);
      return `${todo.done ? "☑" : "☐"} ${text}`;
    })
    .join("\n");
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

function todoSnapshotFromCustomEntry(
  entry: unknown,
): RinTodoSnapshot | undefined {
  const value = entry && typeof entry === "object" ? (entry as any) : null;
  if (!value) return undefined;
  if (value.type !== "custom") return undefined;
  if (safeString(value.customType).trim() !== RIN_TODO_CUSTOM_ENTRY_TYPE) {
    return undefined;
  }
  const data = value.data && typeof value.data === "object" ? value.data : {};
  const todos = normalizeRinTodoItems((data as any).todos);
  if (!todos) return undefined;
  const rawNextId = Number((data as any).nextId);
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
    const next = todoSnapshotFromCustomEntry(entry);
    if (next) latest = next;
  }
  return latest;
}
