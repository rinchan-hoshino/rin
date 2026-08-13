import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import type { PiBuiltinSlashCommand } from "../pi/private-api.js";
import { readNoteSnapshotFromSession } from "../rin-lib/note-state.js";
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

type DisplayItem = {
  id: number;
  text: string;
  done?: boolean;
};

class BranchItemListComponent {
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private readonly title: string,
    private readonly items: DisplayItem[],
    private readonly theme: Theme,
    private readonly onClose: () => void,
    private readonly emptyText: string,
    private readonly showProgress: boolean,
    private readonly showStableIds: boolean,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const lines = [""];
    const title = this.theme.fg("accent", ` ${this.title} `);
    const header =
      this.theme.fg("borderMuted", "─".repeat(3)) +
      title +
      this.theme.fg(
        "borderMuted",
        "─".repeat(Math.max(0, width - this.title.length - 5)),
      );
    lines.push(truncateToWidth(header, width), "");

    if (this.items.length === 0) {
      lines.push(
        truncateToWidth(`  ${this.theme.fg("dim", this.emptyText)}`, width),
      );
    } else {
      const summary = this.showProgress
        ? `${this.items.filter((item) => item.done).length}/${this.items.length} completed`
        : `${this.items.length} ${this.items.length === 1 ? "note" : "notes"}`;
      lines.push(
        truncateToWidth(`  ${this.theme.fg("muted", summary)}`, width),
        "",
      );
      for (const item of this.items) {
        const marker = this.showProgress
          ? item.done
            ? this.theme.fg("success", "✓")
            : this.theme.fg("dim", "○")
          : this.theme.fg("dim", "•");
        const id = this.showStableIds
          ? `${this.theme.fg("accent", `#${item.id}`)} `
          : "";
        const text = item.done
          ? this.theme.fg("dim", item.text)
          : this.theme.fg("text", item.text);
        lines.push(truncateToWidth(`  ${marker} ${id}${text}`, width));
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

async function showItems(
  ui: any,
  input: {
    title: string;
    items: DisplayItem[];
    emptyText: string;
    showProgress: boolean;
    showStableIds: boolean;
  },
) {
  await ui?.custom?.(
    (_tui: unknown, theme: Theme, _keybindings: unknown, done: () => void) =>
      new BranchItemListComponent(
        input.title,
        input.items,
        theme,
        done,
        input.emptyText,
        input.showProgress,
        input.showStableIds,
      ),
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
      await showItems(context.ui, {
        title: "Todos",
        items: readTodoSnapshotFromSession({
          sessionManager: context.sessionManager,
        }).todos,
        emptyText: "No todos yet. Ask the agent to add some!",
        showProgress: true,
        showStableIds: false,
      });
    },
  },
  {
    name: "notes",
    description: "Show all notes on the current branch",
    async execute(_args, context) {
      await showItems(context.ui, {
        title: "Notes",
        items: readNoteSnapshotFromSession({
          sessionManager: context.sessionManager,
        }).items,
        emptyText: "No notes yet. Ask the agent to add verified facts!",
        showProgress: false,
        showStableIds: true,
      });
    },
  },
]);
