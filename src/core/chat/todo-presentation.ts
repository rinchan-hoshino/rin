import {
  formatRinTodoChecklistCharacterContent,
  formatRinTodoChecklistMarkdownContent,
  normalizeRinTodoItems,
  type RinTodoItem,
} from "../rin-lib/todo-state.js";
import { safeString } from "../text-utils.js";
import { parseChatKey } from "./support.js";

export type TodoNoticeRenderMode = "native" | "markdown" | "characters";

export type TodoNoticePresentation = {
  mode: TodoNoticeRenderMode;
  todos: RinTodoItem[] | undefined;
  text: string;
};

function todoNoticeRenderModeForChatKey(chatKey: string): TodoNoticeRenderMode {
  const platform = safeString(parseChatKey(chatKey)?.platform)
    .trim()
    .toLowerCase();
  if (platform === "slack") return "native";
  if (["discord", "feishu", "lark", "telegram"].includes(platform)) {
    return "markdown";
  }
  return "characters";
}

function formatTodoNoticeText(
  todos: ReadonlyArray<Pick<RinTodoItem, "text" | "done">>,
  mode: Exclude<TodoNoticeRenderMode, "native">,
) {
  return mode === "markdown"
    ? formatRinTodoChecklistMarkdownContent(todos)
    : formatRinTodoChecklistCharacterContent(todos);
}

export function presentTodoNotice(
  chatKey: string,
  todoItems: unknown,
  fallbackText: unknown,
): TodoNoticePresentation {
  const mode = todoNoticeRenderModeForChatKey(chatKey);
  const todos = normalizeRinTodoItems(todoItems);
  const text = todos
    ? todos.length > 0
      ? formatTodoNoticeText(todos, mode === "native" ? "characters" : mode)
      : ""
    : safeString(fallbackText).trim();
  return { mode, todos, text };
}
