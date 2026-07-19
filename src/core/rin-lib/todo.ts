/**
 * Rin core todo capability.
 *
 * State is checkpointed in Pi session custom entries, so session branches
 * reconstruct the todo list that belongs to that branch without relying on LLM
 * context-visible tool results.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  formatRinTodoChecklistContent,
  formatRinTodoItemText,
  readTodoSnapshotFromSession,
  RIN_TODO_CUSTOM_ENTRY_TYPE,
} from "./todo-state.js";
import type {
  RinCapabilityDefinition,
  RinCapabilityContext,
} from "./capability-types.js";

export interface Todo {
  id: number;
  text: string;
  done: boolean;
}

type TodoDetailsAction = "write" | "list" | "add" | "toggle" | "clear";

interface TodoDetails {
  action: TodoDetailsAction;
  todos: Todo[];
  nextId: number;
  error?: string;
}

const TodoItemParams: any = Type.Object({
  text: Type.String({
    description: "Checklist item as a concrete branch-execution action.",
  }),
  done: Type.Optional(
    Type.Boolean({
      description: "Whether this checklist item is completed.",
    }),
  ),
});

const TodoParams: any = Type.Object({
  todos: Type.Optional(
    Type.Array(TodoItemParams, {
      description:
        "Complete ordered checklist for the current branch. Omit this property to read the current checklist; pass an empty array to clear it; otherwise include every item that should remain.",
    }),
  ),
});

function normalizeTodoId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().replace(/^#/, "");
  if (!/^\d+$/.test(normalized)) return undefined;
  const id = Number(normalized);
  return Number.isSafeInteger(id) ? id : undefined;
}

const TODO_ACTIONS = new Set<TodoDetailsAction>([
  "write",
  "list",
  "add",
  "toggle",
  "clear",
]);

function cloneTodoItem(value: unknown): Todo | undefined {
  const item = value && typeof value === "object" ? (value as any) : null;
  if (!item) return undefined;
  const id = normalizeTodoId(item.id);
  const text = typeof item.text === "string" ? item.text.trim() : "";
  if (id === undefined || id <= 0 || !text) return undefined;
  return { id, text, done: Boolean(item.done) };
}

function normalizeNextTodoId(todoList: Todo[], value: unknown) {
  const next = Number(value);
  if (Number.isSafeInteger(next) && next > 0) return next;
  return Math.max(0, ...todoList.map((todo) => todo.id)) + 1;
}

function normalizeTodoWriteItems(value: unknown): Todo[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const nextTodos: Todo[] = [];
  for (const item of value) {
    const record = item && typeof item === "object" ? (item as any) : null;
    const text = typeof record?.text === "string" ? record.text.trim() : "";
    if (!text) return undefined;
    nextTodos.push({
      id: nextTodos.length + 1,
      text,
      done: Boolean(record.done),
    });
  }
  return nextTodos;
}

function isTodoReadParams(params: unknown): boolean {
  const value = params && typeof params === "object" ? (params as any) : null;
  return !value || !Object.hasOwn(value, "todos") || value.todos == null;
}

function readTodoDetails(value: unknown): TodoDetails | undefined {
  const details = value && typeof value === "object" ? (value as any) : null;
  if (!details || !Array.isArray(details.todos)) return undefined;
  const todoList = details.todos
    .map(cloneTodoItem)
    .filter((todo): todo is Todo => Boolean(todo));
  const action = TODO_ACTIONS.has(details.action) ? details.action : "list";
  const error = typeof details.error === "string" ? details.error : undefined;
  return {
    action,
    todos: todoList,
    nextId: normalizeNextTodoId(todoList, details.nextId),
    ...(error ? { error } : {}),
  };
}

function formatTodoChecklistContent(todoList: Todo[]): string {
  return formatRinTodoChecklistContent(todoList);
}

function formatTodoChecklistRender(todoList: Todo[], theme: Theme): string {
  if (todoList.length === 0) {
    return theme.fg("dim", "○ No todos");
  }

  return todoList
    .map((todo) => {
      const check = todo.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
      const itemText = formatRinTodoItemText(todo);
      const text = todo.done
        ? theme.fg("dim", itemText)
        : theme.fg("text", itemText);
      return `${check} ${text}`;
    })
    .join("\n");
}

function renderTodoText(text: string) {
  return new Text(text, 0, 0);
}

export default function todoCapability(): RinCapabilityDefinition {
  let todos: Todo[] = [];
  let nextId = 1;
  let activeSessionManager: any;

  const snapshot = (
    action: TodoDetailsAction,
    error?: string,
  ): TodoDetails => ({
    action,
    todos: todos.map((todo) => ({ ...todo })),
    nextId,
    ...(error ? { error } : {}),
  });

  const appendTodoStateEntry = (todoList: Todo[], nextTodoId: number) => {
    if (!activeSessionManager) return;
    const appendCustomEntry = activeSessionManager.appendCustomEntry;
    if (typeof appendCustomEntry !== "function") {
      throw new Error("session custom entries are not available");
    }
    appendCustomEntry.call(activeSessionManager, RIN_TODO_CUSTOM_ENTRY_TYPE, {
      todos: todoList.map((todo) => ({ ...todo })),
      nextId: nextTodoId,
    });
  };

  const reconstructState = (ctx: RinCapabilityContext) => {
    activeSessionManager = ctx.sessionManager;
    const state = readTodoSnapshotFromSession({
      sessionManager: activeSessionManager,
    });
    todos = state.todos.map((todo) => ({ ...todo }));
    nextId = normalizeNextTodoId(todos, state.nextId);
  };

  const todoToolDefinition: any = {
    name: "todo",
    label: "Checklist",
    description: "Read or replace the current branch execution checklist.",
    promptSnippet:
      "Read the current branch checklist by omitting todos, or rewrite it by passing the complete desired todos array.",
    promptGuidelines: [
      "Use todo for current-branch work with multiple concrete execution steps that benefit from a visible checklist.",
      "Omit todos to read the current checklist. After compaction, read it before continuing. Pass the complete desired checklist to replace it; omitted items are removed. Rewrite it immediately when the task objective changes. Pass an empty todos array only to clear the checklist. Clear it before starting a new unrelated task.",
    ],
    parameters: TodoParams,

    async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx) {
      if (isTodoReadParams(params)) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatTodoChecklistContent(todos),
            },
          ],
          details: snapshot("list"),
        };
      }

      const nextTodos = normalizeTodoWriteItems(params.todos);
      if (!nextTodos) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: todos must be omitted or a complete array of non-empty todo items",
            },
          ],
          details: snapshot(
            "write",
            "todos must be omitted or a complete array of non-empty todo items",
          ),
        };
      }

      const nextTodoId = normalizeNextTodoId(nextTodos, undefined);
      try {
        appendTodoStateEntry(nextTodos, nextTodoId);
      } catch (error: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: failed to persist todo state: ${String(error?.message || error)}`,
            },
          ],
          details: snapshot(
            "write",
            `failed to persist todo state: ${String(error?.message || error)}`,
          ),
        };
      }

      todos = nextTodos;
      nextId = nextTodoId;
      return {
        content: [
          {
            type: "text" as const,
            text: formatTodoChecklistContent(todos),
          },
        ],
        details: snapshot(todos.length === 0 ? "clear" : "write"),
      };
    },

    renderCall(args: any, theme, context) {
      if (context?.isPartial === false) return renderTodoText("");
      if (isTodoReadParams(args)) {
        return renderTodoText(formatTodoChecklistRender(todos, theme));
      }
      const nextTodos = normalizeTodoWriteItems(args?.todos);
      return renderTodoText(
        nextTodos ? formatTodoChecklistRender(nextTodos, theme) : "",
      );
    },

    renderResult(result, _options, theme, _context) {
      const details = readTodoDetails(result.details);
      if (!details) {
        const text = result.content[0];
        return renderTodoText(text?.type === "text" ? text.text : "");
      }

      const checklist = formatTodoChecklistRender(details.todos, theme);
      if (details.error) {
        return renderTodoText(
          `${theme.fg("error", `Error: ${details.error}`)}\n${checklist}`,
        );
      }

      return renderTodoText(checklist);
    },
  };

  return {
    name: "todo",
    tools: [todoToolDefinition],
    hooks: {
      session_start: [async (_event, ctx) => reconstructState(ctx)],
      session_tree: [async (_event, ctx) => reconstructState(ctx)],
    },
  };
}
