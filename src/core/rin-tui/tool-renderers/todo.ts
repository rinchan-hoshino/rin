import type { TodoToolDetails } from "../../rin-lib/core-tool-contracts.js";
import {
  fallbackItemToolResult,
  renderItemToolCall,
  updateItemToolText,
} from "./item.js";

function parseTodoItems(value: unknown): TodoToolDetails["items"] | undefined {
  const details = value as Partial<TodoToolDetails> | undefined;
  return Array.isArray(details?.items) ? details.items : undefined;
}

function formatTodos(items: TodoToolDetails["items"], theme: any) {
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

export const todoToolRenderer = {
  name: "todo",
  renderCall(args: any, theme: any, context: any) {
    return renderItemToolCall("todo", args, theme, context);
  },
  renderResult(value: any, _options: any, theme: any, context: any) {
    const items = parseTodoItems(value?.details);
    if (!items) return fallbackItemToolResult(value, context);
    const checklist = formatTodos(items, theme);
    const error =
      typeof value.details?.error === "string" ? value.details.error : "";
    return updateItemToolText(
      error
        ? [theme.fg("error", `Error: ${error}`), checklist]
            .filter(Boolean)
            .join("\n")
        : checklist,
      context,
    );
  },
};
