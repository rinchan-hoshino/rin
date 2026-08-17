import {
  formatRinTodoChecklistMarkdownContent,
  normalizeRinTodoItems,
  type RinTodoItem,
} from "../rin-lib/todo-state.js";
import { safeString } from "../text-utils.js";

export type TodoNoticePresentation = {
  mode: "markdown";
  todos: RinTodoItem[] | undefined;
  text: string;
};

export function presentTodoNotice(
  _chatKey: string,
  todoItems: unknown,
  fallbackText: unknown,
): TodoNoticePresentation {
  const todos = normalizeRinTodoItems(todoItems);
  const text = todos
    ? todos.length > 0
      ? formatRinTodoChecklistMarkdownContent(todos)
      : ""
    : safeString(fallbackText).trim();
  return { mode: "markdown", todos, text };
}
