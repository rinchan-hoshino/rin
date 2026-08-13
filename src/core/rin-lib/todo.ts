/**
 * Rin core todo capability.
 *
 * The agent mutates one stable-ID item at a time (or an explicit add/remove
 * group). State is checkpointed in Pi session custom entries and follows the
 * selected session branch.
 */

import { Type } from "typebox";
import type {
  RinCapabilityContext,
  RinCapabilityDefinition,
} from "./capability-types.js";
import type { TodoToolDetails } from "./core-tool-contracts.js";
import {
  createItemToolParameters,
  formatItemReadWindowContent,
  normalizeItemId,
  normalizeNextItemId,
  resolveInsertIndex,
  resolveItemReadWindow,
  resolveSelectedItemIds,
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
    text: Type.String({ minLength: 1, description: "Replacement item text." }),
  },
  { additionalProperties: false },
);

const TODO_ACTIONS: readonly ItemAction[] = [
  "read",
  "add",
  "edit",
  "remove",
  "toggle",
  "clear",
];

const TodoParams: any = createItemToolParameters(
  TodoAddItemParams,
  TodoEditItemParams,
  { actions: TODO_ACTIONS },
);

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

function normalizeEdit(value: unknown): { text: string } | undefined {
  const item = value && typeof value === "object" ? (value as any) : null;
  if (!item || Object.keys(item).some((key) => key !== "text")) {
    return undefined;
  }
  const text = typeof item.text === "string" ? item.text.trim() : "";
  return text ? { text } : undefined;
}

function formatTodoContent(items: Todo[]) {
  if (items.length === 0) return "";
  return items
    .map(
      (item) =>
        `[${item.done ? "x" : " "}] #${item.id} ${formatRinTodoItemText(item)}`,
    )
    .join("\n");
}

export default function todoCapability(): RinCapabilityDefinition {
  let items: Todo[] = [];
  let nextId = 1;
  let activeSessionManager: any;

  const details = (
    action: ItemAction,
    error?: string,
    readWindow?: ItemReadWindow<Todo>,
  ): TodoToolDetails => ({
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
      "Maintain the current-branch execution checklist by stable item ID. Read returns the full list by default or a 1-based offset/limit range; add accepts one or more items and can insert before an ID; edit changes item text; remove deletes selected IDs; toggle changes the completion state of one or more selected IDs atomically; clear removes every item.",
    promptSnippet: "Current-branch execution checklist.",
    promptGuidelines: [
      "Use todo when current-branch work has multiple concrete execution steps that benefit from a visible checklist.",
    ],
    parameters: TodoParams,

    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const validated = validateItemActionParams(params, TODO_ACTIONS);
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
        nextItems[index] = { ...nextItems[index]!, text: edit.text };
        return commit("edit", nextItems, nextId);
      }

      if (action === "toggle") {
        const selection = resolveSelectedItemIds("toggle", params, items);
        if (selection.error) return result("toggle", selection.error);
        const selected = new Set(selection.ids);
        const nextItems = items.map((item) => ({
          ...item,
          done: selected.has(item.id) ? !item.done : item.done,
        }));
        return commit("toggle", nextItems, nextId);
      }

      if (action === "clear") {
        return commit("clear", [], 1);
      }

      const removal = resolveSelectedItemIds("remove", params, items);
      if (removal.error) return result("remove", removal.error);
      const nextItems = items
        .filter((item) => !removal.ids!.includes(item.id))
        .map((item) => ({ ...item }));
      return commit("remove", nextItems, nextId);
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
