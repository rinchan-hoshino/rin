/**
 * Rin core todo capability.
 *
 * The agent mutates one stable-ID item at a time (or an explicit add/remove
 * group). State is checkpointed in Pi session custom entries and follows the
 * selected session branch.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type {
  RinCapabilityContext,
  RinCapabilityDefinition,
} from "./capability-types.js";
import {
  createItemToolParameters,
  formatItemReadWindowContent,
  normalizeItemId,
  normalizeNextItemId,
  resolveInsertIndex,
  resolveItemReadWindow,
  resolveRemovalIds,
  type ItemAction,
  type ItemReadWindow,
  validateItemActionParams,
} from "./item-tool.js";
import {
  formatRinTodoItemText,
  readTodoSnapshotFromSession,
  RIN_TODO_CUSTOM_ENTRY_TYPE,
} from "./todo-state.js";

export interface Todo {
  id: number;
  text: string;
  done: boolean;
}

interface TodoDetails {
  action: ItemAction;
  items: Todo[];
  nextId: number;
  error?: string;
}

const TodoAddItemParams: any = Type.Object(
  {
    text: Type.String({
      minLength: 1,
      description: "Checklist item as a concrete branch-execution action.",
    }),
    done: Type.Optional(
      Type.Boolean({ description: "Whether this item is completed." }),
    ),
  },
  { additionalProperties: false },
);

const TodoEditItemParams: any = Type.Object(
  {
    text: Type.Optional(
      Type.String({ minLength: 1, description: "Replacement item text." }),
    ),
    done: Type.Optional(
      Type.Boolean({ description: "Replacement completion state." }),
    ),
  },
  { additionalProperties: false },
);

const TodoParams: any = createItemToolParameters(
  TodoAddItemParams,
  TodoEditItemParams,
);

function cloneTodo(value: unknown): Todo | undefined {
  const item = value && typeof value === "object" ? (value as any) : null;
  if (!item) return undefined;
  const id = normalizeItemId(item.id);
  const text = typeof item.text === "string" ? item.text.trim() : "";
  if (id === undefined || !text) return undefined;
  return { id, text, done: Boolean(item.done) };
}

function normalizeAddItems(
  value: unknown,
): Array<Omit<Todo, "id">> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const items: Array<Omit<Todo, "id">> = [];
  for (const raw of value) {
    const item = raw && typeof raw === "object" ? (raw as any) : null;
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (!text) return undefined;
    const keys = Object.keys(item);
    if (keys.some((key) => key !== "text" && key !== "done")) return undefined;
    if (item.done !== undefined && typeof item.done !== "boolean") {
      return undefined;
    }
    items.push({ text, done: item.done ?? false });
  }
  return items;
}

function normalizeEdit(
  value: unknown,
): Partial<Pick<Todo, "text" | "done">> | undefined {
  const item = value && typeof value === "object" ? (value as any) : null;
  if (!item) return undefined;
  const keys = Object.keys(item);
  if (
    keys.length === 0 ||
    keys.some((key) => key !== "text" && key !== "done")
  ) {
    return undefined;
  }
  const edit: Partial<Pick<Todo, "text" | "done">> = {};
  if (Object.hasOwn(item, "text")) {
    if (typeof item.text !== "string" || !item.text.trim()) return undefined;
    edit.text = item.text.trim();
  }
  if (Object.hasOwn(item, "done")) {
    if (typeof item.done !== "boolean") return undefined;
    edit.done = item.done;
  }
  return edit;
}

function readTodoDetails(value: unknown): TodoDetails | undefined {
  const details = value && typeof value === "object" ? (value as any) : null;
  if (!details || !Array.isArray(details.items)) return undefined;
  const items = details.items
    .map(cloneTodo)
    .filter((item): item is Todo => Boolean(item));
  const action = ["read", "add", "edit", "remove"].includes(details.action)
    ? details.action
    : "read";
  return {
    action,
    items,
    nextId: normalizeNextItemId(items, details.nextId),
    ...(typeof details.error === "string" ? { error: details.error } : {}),
  };
}

function formatTodoContent(items: Todo[]) {
  if (items.length === 0) return "No todos";
  return items
    .map(
      (item) =>
        `[${item.done ? "x" : " "}] #${item.id} ${formatRinTodoItemText(item)}`,
    )
    .join("\n");
}

function formatTodoRender(items: Todo[], theme: Theme): string {
  if (items.length === 0) return theme.fg("dim", "○ No todos");
  return items
    .map((item) => {
      const check = item.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
      const text = item.done
        ? theme.fg("dim", item.text)
        : theme.fg("text", item.text);
      return `${check} ${text}`;
    })
    .join("\n");
}

function renderText(text: string) {
  return new Text(text, 0, 0);
}

export default function todoCapability(): RinCapabilityDefinition {
  let items: Todo[] = [];
  let nextId = 1;
  let activeSessionManager: any;

  const details = (
    action: ItemAction,
    error?: string,
    readWindow?: ItemReadWindow<Todo>,
  ): TodoDetails => ({
    action,
    items: (readWindow?.items ?? items).map((item) => ({ ...item })),
    nextId,
    ...(error ? { error } : {}),
  });

  const result = (
    action: ItemAction,
    error?: string,
    readWindow?: ItemReadWindow<Todo>,
  ) => ({
    content: [
      {
        type: "text" as const,
        text: error
          ? `Error: ${error}`
          : formatItemReadWindowContent(
              readWindow ?? { items, ranged: false },
              formatTodoContent,
            ),
      },
    ],
    details: details(action, error, readWindow),
  });

  const persist = (nextItems: Todo[], nextItemId: number) => {
    const appendCustomEntry = activeSessionManager?.appendCustomEntry;
    if (typeof appendCustomEntry !== "function") {
      throw new Error("session custom entries are not available");
    }
    appendCustomEntry.call(activeSessionManager, RIN_TODO_CUSTOM_ENTRY_TYPE, {
      todos: nextItems.map((item) => ({ ...item })),
      nextId: nextItemId,
    });
    items = nextItems;
    nextId = nextItemId;
  };

  const commit = (
    action: ItemAction,
    nextItems: Todo[],
    nextItemId: number,
  ) => {
    try {
      persist(nextItems, nextItemId);
      return result(action);
    } catch (error: any) {
      return result(
        action,
        `failed to persist todo state: ${String(error?.message || error)}`,
      );
    }
  };

  const reconstructState = (ctx: RinCapabilityContext) => {
    activeSessionManager = ctx.sessionManager;
    const state = readTodoSnapshotFromSession({
      sessionManager: activeSessionManager,
    });
    items = state.todos.map((item) => ({ ...item }));
    nextId = normalizeNextItemId(items, state.nextId);
  };

  const tool: any = {
    name: "todo",
    label: "Checklist",
    description:
      "Maintain the current-branch execution checklist by stable item ID. Read returns the full list by default or a 1-based offset/limit range; add accepts one or more items and can insert before an ID; edit changes one item; remove deletes selected IDs or clears all.",
    promptSnippet:
      "Read the full branch checklist or a range, or add, edit, and remove checklist items by stable ID.",
    promptGuidelines: [
      "Use todo for current-branch work with multiple concrete execution steps that benefit from a visible checklist.",
      "Use action read without offset/limit for the full list or with a 1-based item offset and positive limit for a range. Use add with items and optional beforeId, edit with exactly one id and item patch, and remove with ids or all: true. Read before mutating when stable IDs are unknown or uncertain.",
      "After compaction, trust the current-branch snapshot injected by Rin; never reconstruct it from prose. Remove obsolete items individually, and clear all before starting a new unrelated task.",
    ],
    parameters: TodoParams,

    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const validated = validateItemActionParams(params);
      const action = validated.action ?? "read";
      if (validated.error) return result(action, validated.error);
      if (action === "read") {
        return result("read", undefined, resolveItemReadWindow(items, params));
      }
      if (signal?.aborted) return result(action, "operation aborted");

      if (action === "add") {
        const additions = normalizeAddItems(params.items);
        if (!additions) {
          return result("add", "add requires one or more valid todo items");
        }
        const insertion = resolveInsertIndex(items, params.beforeId);
        if (insertion.error) return result("add", insertion.error);
        let allocatedId = nextId;
        const added = additions.map((item) => ({ id: allocatedId++, ...item }));
        const nextItems = items.map((item) => ({ ...item }));
        nextItems.splice(insertion.index!, 0, ...added);
        return commit("add", nextItems, allocatedId);
      }

      if (action === "edit") {
        const id = normalizeItemId(params.id);
        const edit = normalizeEdit(params.item);
        if (id === undefined || !edit) {
          return result(
            "edit",
            "edit requires one valid id and a non-empty item patch",
          );
        }
        const index = items.findIndex((item) => item.id === id);
        if (index < 0) return result("edit", `#${id} not found`);
        const nextItems = items.map((item) => ({ ...item }));
        nextItems[index] = { ...nextItems[index]!, ...edit };
        return commit("edit", nextItems, nextId);
      }

      const removal = resolveRemovalIds(params, items);
      if (removal.error) return result("remove", removal.error);
      const nextItems = removal.clear
        ? []
        : items
            .filter((item) => !removal.ids!.includes(item.id))
            .map((item) => ({ ...item }));
      return commit("remove", nextItems, removal.clear ? 1 : nextId);
    },

    renderCall(args: any, theme: Theme, context: any) {
      if (context?.isPartial === false) return renderText("");
      const action = String(args?.action || "").trim();
      return renderText(
        theme.fg("toolTitle", action ? `todo ${action}` : "todo …"),
      );
    },

    renderResult(value: any, _options: any, theme: Theme) {
      const parsed = readTodoDetails(value.details);
      if (!parsed) {
        const text = value.content?.[0];
        return renderText(text?.type === "text" ? text.text : "");
      }
      const checklist = formatTodoRender(parsed.items, theme);
      return renderText(
        parsed.error
          ? `${theme.fg("error", `Error: ${parsed.error}`)}\n${checklist}`
          : checklist,
      );
    },
  };

  return {
    name: "todo",
    tools: [tool],
    hooks: {
      session_start: [async (_event, ctx) => reconstructState(ctx)],
      session_tree: [async (_event, ctx) => reconstructState(ctx)],
    },
  };
}
