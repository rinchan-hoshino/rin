/**
 * Rin core todo capability.
 *
 * State is stored in tool result details instead of an external file, so session
 * branches reconstruct the todo list that belongs to that branch.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  matchesKey,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type {
  RinCapabilityDefinition,
  RinCapabilityContext,
} from "./capability-types.js";

export interface Todo {
  id: number;
  text: string;
  done: boolean;
}

interface TodoDetails {
  action: "list" | "add" | "toggle" | "clear";
  todos: Todo[];
  nextId: number;
  error?: string;
}

const TodoParams: any = Type.Object({
  action: StringEnum(["list", "add", "toggle", "clear"] as const),
  text: Type.Optional(Type.String({ description: "Todo text (for add)." })),
  id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)." })),
});

function normalizeTodoId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().replace(/^#/, "");
  if (!/^\d+$/.test(normalized)) return undefined;
  const id = Number(normalized);
  return Number.isSafeInteger(id) ? id : undefined;
}

const TODO_ACTIONS = new Set<TodoDetails["action"]>([
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
  if (todoList.length === 0) return "○ No todos";

  return todoList
    .map((todo) => `${todo.done ? "✓" : "○"} ${todo.text}`)
    .join("\n");
}

function formatTodoChecklistRender(
  todoList: Todo[],
  expanded: boolean,
  theme: Theme,
): string {
  if (todoList.length === 0) {
    return theme.fg("dim", "○ No todos");
  }

  const display = expanded ? todoList : todoList.slice(0, 5);
  const lines = display.map((todo) => {
    const check = todo.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
    const text = todo.done
      ? theme.fg("dim", todo.text)
      : theme.fg("text", todo.text);
    return `${check} ${text}`;
  });

  if (!expanded && todoList.length > 5) {
    lines.push(theme.fg("dim", `… ${todoList.length - 5} more`));
  }

  return lines.join("\n");
}

function renderTodoText(text: string) {
  return new Text(text, 0, 0);
}

class TodoListComponent {
  private todos: Todo[];
  private theme: Theme;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(todos: Todo[], theme: Theme, onClose: () => void) {
    this.todos = todos;
    this.theme = theme;
    this.onClose = onClose;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const th = this.theme;

    lines.push("");
    const title = th.fg("accent", " Checklist ");
    const headerLine =
      th.fg("borderMuted", "─".repeat(3)) +
      title +
      th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
    lines.push(truncateToWidth(headerLine, width));
    lines.push("");

    if (this.todos.length === 0) {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "○ No todos yet. Ask the agent to add some!")}`,
          width,
        ),
      );
    } else {
      const done = this.todos.filter((todo) => todo.done).length;
      const total = this.todos.length;
      lines.push(
        truncateToWidth(
          `  ${th.fg("muted", `${done}/${total} completed`)}`,
          width,
        ),
      );
      lines.push("");

      for (const todo of this.todos) {
        const check = todo.done ? th.fg("success", "✓") : th.fg("dim", "○");
        const text = todo.done
          ? th.fg("dim", todo.text)
          : th.fg("text", todo.text);
        lines.push(truncateToWidth(`  ${check} ${text}`, width));
      }
    }

    lines.push("");
    lines.push(
      truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width),
    );
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

export async function showTodoList(ui: any, todos: Todo[]) {
  if (!ui || typeof ui.custom !== "function") {
    ui?.notify?.("/todos requires interactive mode", "error");
    return false;
  }
  await ui.custom((_tui: any, theme: Theme, _kb: any, done: () => void) => {
    return new TodoListComponent(todos, theme, () => done());
  });
  return true;
}

export default function todoCapability(): RinCapabilityDefinition {
  let todos: Todo[] = [];
  let nextId = 1;

  const snapshot = (
    action: TodoDetails["action"],
    error?: string,
  ): TodoDetails => ({
    action,
    todos: todos.map((todo) => ({ ...todo })),
    nextId,
    ...(error ? { error } : {}),
  });

  const reconstructState = (ctx: RinCapabilityContext) => {
    todos = [];
    nextId = 1;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

      const details = readTodoDetails(msg.details);
      if (!details) continue;
      todos = details.todos.map((todo) => ({ ...todo }));
      nextId = details.nextId;
    }
  };

  const todoToolDefinition: any = {
    name: "todo",
    label: "Checklist",
    description:
      "Manage the current session todo checklist. Actions: list, add (text), toggle (id), clear.",
    promptSnippet:
      "Manage the current branch todo checklist: list items, add concrete steps, toggle completion, or clear it.",
    promptGuidelines: [
      "Use todo for multi-step task tracking when a structured checklist would reduce missed work.",
      "Keep todo current: add concrete steps before long work and toggle items as they are completed.",
      "Todo output is user-visible checklist state; read and write actions should leave the checklist display current.",
    ],
    parameters: TodoParams,

    async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx) {
      switch (params.action) {
        case "list":
          return {
            content: [
              {
                type: "text" as const,
                text: formatTodoChecklistContent(todos),
              },
            ],
            details: snapshot("list"),
          };

        case "add": {
          if (!params.text) {
            return {
              content: [
                { type: "text" as const, text: "Error: text required for add" },
              ],
              details: snapshot("add", "text required"),
            };
          }
          const newTodo: Todo = {
            id: nextId++,
            text: params.text,
            done: false,
          };
          todos.push(newTodo);
          return {
            content: [
              {
                type: "text" as const,
                text: formatTodoChecklistContent(todos),
              },
            ],
            details: snapshot("add"),
          };
        }

        case "toggle": {
          if (params.id === undefined) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: id required for toggle",
                },
              ],
              details: snapshot("toggle", "id required"),
            };
          }
          const id = normalizeTodoId(params.id);
          if (id === undefined) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: id must be a todo number for toggle",
                },
              ],
              details: snapshot("toggle", "id must be a todo number"),
            };
          }
          const todo = todos.find((item) => item.id === id);
          if (!todo) {
            return {
              content: [
                { type: "text" as const, text: `Todo #${id} not found` },
              ],
              details: snapshot("toggle", `#${id} not found`),
            };
          }
          todo.done = !todo.done;
          return {
            content: [
              {
                type: "text" as const,
                text: formatTodoChecklistContent(todos),
              },
            ],
            details: snapshot("toggle"),
          };
        }

        case "clear": {
          todos = [];
          nextId = 1;
          return {
            content: [
              {
                type: "text" as const,
                text: formatTodoChecklistContent(todos),
              },
            ],
            details: snapshot("clear"),
          };
        }

        default:
          return {
            content: [
              {
                type: "text" as const,
                text: `Unknown action: ${params.action}`,
              },
            ],
            details: snapshot("list", `unknown action: ${params.action}`),
          };
      }
    },

    renderCall(_args: any, _theme, _context) {
      return new Container();
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = readTodoDetails(result.details);
      if (!details) {
        const text = result.content[0];
        return renderTodoText(text?.type === "text" ? text.text : "");
      }

      const checklist = formatTodoChecklistRender(
        details.todos,
        expanded,
        theme,
      );
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
