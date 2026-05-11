/**
 * Rin Todo Extension - built from Pi's stateful todo extension example.
 *
 * State is stored in tool result details instead of an external file, so session
 * branches reconstruct the todo list that belongs to that branch.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Todo {
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
    const title = th.fg("accent", " Todos ");
    const headerLine =
      th.fg("borderMuted", "─".repeat(3)) +
      title +
      th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
    lines.push(truncateToWidth(headerLine, width));
    lines.push("");

    if (this.todos.length === 0) {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`,
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
        const id = th.fg("accent", `#${todo.id}`);
        const text = todo.done
          ? th.fg("dim", todo.text)
          : th.fg("text", todo.text);
        lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
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

export default function todoExtension(pi: ExtensionAPI) {
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

  const reconstructState = (ctx: ExtensionContext) => {
    todos = [];
    nextId = 1;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

      const details = msg.details as TodoDetails | undefined;
      if (!details) continue;
      todos = details.todos.map((todo) => ({ ...todo }));
      nextId = details.nextId;
    }
  };

  pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

  const todoToolDefinition: any = {
    name: "todo",
    label: "Todo",
    description:
      "Manage the current session todo list. Actions: list, add (text), toggle (id), clear.",
    promptSnippet:
      "Manage the current branch todo list: list items, add concrete steps, toggle completion, or clear it.",
    promptGuidelines: [
      "Use todo for multi-step task tracking when a structured checklist would reduce missed work.",
      "Keep todo current: add concrete steps before long work and toggle items as they are completed.",
    ],
    parameters: TodoParams,

    async execute(_toolCallId, params: any, _signal, _onUpdate, _ctx) {
      switch (params.action) {
        case "list":
          return {
            content: [
              {
                type: "text" as const,
                text: todos.length
                  ? todos
                      .map(
                        (todo) =>
                          `[${todo.done ? "x" : " "}] #${todo.id}: ${todo.text}`,
                      )
                      .join("\n")
                  : "No todos",
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
                text: `Added todo #${newTodo.id}: ${newTodo.text}`,
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
                text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}`,
              },
            ],
            details: snapshot("toggle"),
          };
        }

        case "clear": {
          const count = todos.length;
          todos = [];
          nextId = 1;
          return {
            content: [
              { type: "text" as const, text: `Cleared ${count} todos` },
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

    renderCall(args: any, theme, _context) {
      let text =
        theme.fg("toolTitle", theme.bold("todo ")) +
        theme.fg("muted", args.action);
      if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
      if (args.id !== undefined)
        text += ` ${theme.fg("accent", `#${args.id}`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as TodoDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      if (details.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      const todoList = details.todos;

      switch (details.action) {
        case "list": {
          if (todoList.length === 0) {
            return new Text(theme.fg("dim", "No todos"), 0, 0);
          }
          let listText = theme.fg("muted", `${todoList.length} todo(s):`);
          const display = expanded ? todoList : todoList.slice(0, 5);
          for (const todo of display) {
            const check = todo.done
              ? theme.fg("success", "✓")
              : theme.fg("dim", "○");
            const itemText = todo.done
              ? theme.fg("dim", todo.text)
              : theme.fg("muted", todo.text);
            listText += `\n${check} ${theme.fg("accent", `#${todo.id}`)} ${itemText}`;
          }
          if (!expanded && todoList.length > 5) {
            listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
          }
          return new Text(listText, 0, 0);
        }

        case "add": {
          const added = todoList[todoList.length - 1];
          return new Text(
            theme.fg("success", "✓ Added ") +
              theme.fg("accent", `#${added.id}`) +
              " " +
              theme.fg("muted", added.text),
            0,
            0,
          );
        }

        case "toggle": {
          const text = result.content[0];
          const message = text?.type === "text" ? text.text : "";
          return new Text(
            theme.fg("success", "✓ ") + theme.fg("muted", message),
            0,
            0,
          );
        }

        case "clear":
          return new Text(
            theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"),
            0,
            0,
          );
      }
    },
  };

  pi.registerTool(todoToolDefinition);

  pi.registerCommand("todos", {
    description: "Show all todos on the current branch",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/todos requires interactive mode", "error");
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new TodoListComponent(todos, theme, () => done());
      });
    },
  });
}
