import type { TruncationResult } from "@earendil-works/pi-coding-agent";

import type { ItemAction } from "./item-tool.js";
import type { RinTodoItem } from "./todo-state.js";

export type TodoToolDetails = {
  action: ItemAction;
  items: RinTodoItem[];
  nextId: number;
  error?: string;
};

export type RecallToolDetails = {
  truncation?: TruncationResult;
  emptyMessage?: string;
  hiddenCount?: number;
  totalResults?: number;
  userText?: string;
  phase?: "search" | "recent" | "summarize";
};
