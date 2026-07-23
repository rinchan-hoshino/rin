import fs from "node:fs/promises";

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
      return `${todo.done ? "✅" : "⬜"} ${todo.done ? `~~${text}~~` : text}`;
    })
    .join("\n");
}

export function formatRinTodoChecklistCharacterContent(
  todos: ReadonlyArray<Pick<RinTodoItem, "text" | "done">>,
): string {
  if (todos.length === 0) return "No todos";

  return todos
    .map((todo) => `${todo.done ? "✅" : "⬜"} ${formatRinTodoLineText(todo)}`)
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

function activeBranchFromEntries(entries: unknown[], expectedLeafId?: string) {
  const records = entries.filter((entry): entry is Record<string, any> =>
    Boolean(entry && typeof entry === "object"),
  );
  const entriesById = new Map(
    records
      .map((entry) => [safeString(entry.id).trim(), entry] as const)
      .filter(([id]) => Boolean(id)),
  );
  const leafId =
    safeString(expectedLeafId).trim() ||
    [...records]
      .reverse()
      .map((entry) => safeString(entry.id).trim())
      .find(Boolean);
  if (!leafId) return records;

  const leaf = entriesById.get(leafId);
  if (!leaf) return undefined;
  if (expectedLeafId && safeString(leaf.message?.role).trim() !== "user") {
    return undefined;
  }
  const branch: Record<string, any>[] = [];
  const visited = new Set<string>();
  let entryId: string | undefined = leafId;
  while (entryId) {
    if (visited.has(entryId)) return undefined;
    visited.add(entryId);
    const entry = entriesById.get(entryId);
    if (!entry) return undefined;
    branch.push(entry);
    entryId = safeString(entry.parentId).trim() || undefined;
  }
  return branch.reverse();
}

async function readSessionFileEntries(sessionFile: unknown) {
  const filePath = safeString(sessionFile).trim();
  if (!filePath) return undefined;
  try {
    const entries: unknown[] = [];
    for (const line of (await fs.readFile(filePath, "utf8")).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        return undefined;
      }
    }
    return entries;
  } catch {
    return undefined;
  }
}

function readTodoSnapshotFromEntries(entries: unknown[]): RinTodoSnapshot {
  let latest: RinTodoSnapshot = todoSnapshot();
  for (const entry of entries) {
    const next = todoSnapshotFromCustomEntry(entry);
    if (next) latest = next;
  }
  return latest;
}

export function readTodoSnapshotFromSession(session: any): RinTodoSnapshot {
  return readTodoSnapshotFromEntries(branchEntriesFromSession(session));
}

export async function readTodoSnapshotFromSessionFile(
  sessionFile: unknown,
  expectedLeafId?: string,
): Promise<RinTodoSnapshot | undefined> {
  const entries = await readSessionFileEntries(sessionFile);
  if (!entries) return undefined;
  const branch = activeBranchFromEntries(entries, expectedLeafId);
  return branch ? readTodoSnapshotFromEntries(branch) : undefined;
}
