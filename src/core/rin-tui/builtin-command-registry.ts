import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import type { PiBuiltinSlashCommand } from "../pi/private-api.js";
import { readTodoSnapshotFromSession } from "../rin-lib/todo-state.js";

export type RinTuiBuiltinCommandContext = {
  sessionManager: any;
  ui: any;
};

type RinTuiBuiltinCommandDefinition = PiBuiltinSlashCommand & {
  execute: (
    args: string,
    context: RinTuiBuiltinCommandContext,
  ) => Promise<void>;
};

type DisplayTodo = {
  text: string;
  done: boolean;
};

class BranchTodoListComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly todos: DisplayTodo[],
    private readonly theme: Theme,
    private readonly onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const lines = [""];
    const title = this.theme.fg("accent", " Todos ");
    const header =
      this.theme.fg("borderMuted", "─".repeat(3)) +
      title +
      this.theme.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
    lines.push(truncateToWidth(header, width), "");

    if (this.todos.length === 0) {
      lines.push(
        truncateToWidth(
          `  ${this.theme.fg("dim", "No todos yet. Ask the agent to add some!")}`,
          width,
        ),
      );
    } else {
      const completed = this.todos.filter((todo) => todo.done).length;
      lines.push(
        truncateToWidth(
          `  ${this.theme.fg("muted", `${completed}/${this.todos.length} completed`)}`,
          width,
        ),
        "",
      );
      for (const todo of this.todos) {
        const marker = todo.done
          ? this.theme.fg("success", "✓")
          : this.theme.fg("dim", "○");
        const text = todo.done
          ? this.theme.fg("dim", todo.text)
          : this.theme.fg("text", todo.text);
        lines.push(truncateToWidth(`  ${marker} ${text}`, width));
      }
    }

    lines.push(
      "",
      truncateToWidth(
        `  ${this.theme.fg("dim", "Press Escape to close")}`,
        width,
      ),
      "",
    );
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

async function showTodos(ui: any, todos: DisplayTodo[]) {
  await ui?.custom?.(
    (_tui: unknown, theme: Theme, _keybindings: unknown, done: () => void) =>
      new BranchTodoListComponent(todos, theme, done),
  );
}

function createBuiltinCommandRegistry(
  definitions: readonly RinTuiBuiltinCommandDefinition[],
) {
  const commands = definitions.map(({ execute: _execute, ...command }) =>
    Object.freeze(command),
  );
  const byName = new Map<string, RinTuiBuiltinCommandDefinition>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      throw new Error(`duplicate_rin_tui_builtin_command:${definition.name}`);
    }
    byName.set(definition.name, definition);
  }

  return Object.freeze({
    commands: Object.freeze(commands),
    async execute(commandLine: string, context: RinTuiBuiltinCommandContext) {
      const match = /^\/([^\s]+)(?:\s+(.*))?$/.exec(
        String(commandLine || "").trim(),
      );
      if (!match) return false;
      const definition = byName.get(match[1]);
      if (!definition) return false;
      await definition.execute(String(match[2] || "").trim(), context);
      return true;
    },
  });
}

export const RIN_TUI_BUILTIN_COMMAND_REGISTRY = createBuiltinCommandRegistry([
  {
    name: "todos",
    description: "Show all todos on the current branch",
    async execute(_args, context) {
      await showTodos(
        context.ui,
        readTodoSnapshotFromSession({
          sessionManager: context.sessionManager,
        }).todos,
      );
    },
  },
]);
