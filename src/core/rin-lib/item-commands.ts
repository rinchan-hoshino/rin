import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

import { readNoteSnapshotFromSession } from "./note-state.js";
import { readTodoSnapshotFromSession } from "./todo-state.js";

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
    const theme = this.theme;
    const lines = [""];
    const title = theme.fg("accent", ` ${this.title} `);
    const header =
      theme.fg("borderMuted", "─".repeat(3)) +
      title +
      theme.fg(
        "borderMuted",
        "─".repeat(Math.max(0, width - this.title.length - 5)),
      );
    lines.push(truncateToWidth(header, width), "");

    if (this.items.length === 0) {
      lines.push(
        truncateToWidth(`  ${theme.fg("dim", this.emptyText)}`, width),
      );
    } else {
      if (this.showProgress) {
        const done = this.items.filter((item) => item.done).length;
        lines.push(
          truncateToWidth(
            `  ${theme.fg("muted", `${done}/${this.items.length} completed`)}`,
            width,
          ),
          "",
        );
      } else {
        lines.push(
          truncateToWidth(
            `  ${theme.fg("muted", `${this.items.length} ${this.items.length === 1 ? "note" : "notes"}`)}`,
            width,
          ),
          "",
        );
      }
      for (const item of this.items) {
        const marker = this.showProgress
          ? item.done
            ? theme.fg("success", "✓")
            : theme.fg("dim", "○")
          : theme.fg("dim", "•");
        const id = this.showStableIds
          ? `${theme.fg("accent", `#${item.id}`)} `
          : "";
        const text = item.done
          ? theme.fg("dim", item.text)
          : theme.fg("text", item.text);
        lines.push(truncateToWidth(`  ${marker} ${id}${text}`, width));
      }
    }

    lines.push(
      "",
      truncateToWidth(`  ${theme.fg("dim", "Press Escape to close")}`, width),
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
  ctx: ExtensionCommandContext,
  input: {
    title: string;
    items: DisplayItem[];
    emptyText: string;
    showProgress: boolean;
    showStableIds: boolean;
  },
) {
  if (ctx.mode !== "tui") {
    const plain =
      input.items.length === 0
        ? input.emptyText
        : input.items
            .map((item) => {
              const marker = input.showProgress
                ? `[${item.done ? "x" : " "}]`
                : "-";
              return `${marker} #${item.id} ${item.text}`;
            })
            .join("\n");
    ctx.ui.notify(plain, "info");
    return;
  }
  await ctx.ui.custom<void>(
    (_tui, theme, _keybindings, done) =>
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

export default function itemCommandsExtension(pi: ExtensionAPI) {
  pi.registerCommand("todos", {
    description: "Show all todos on the current branch",
    handler: async (_args, ctx) => {
      const items = readTodoSnapshotFromSession(ctx).todos;
      await showItems(ctx, {
        title: "Todos",
        items,
        emptyText: "No todos yet. Ask the agent to add some!",
        showProgress: true,
        showStableIds: false,
      });
    },
  });

  pi.registerCommand("notes", {
    description: "Show all notes on the current branch",
    handler: async (_args, ctx) => {
      const items = readNoteSnapshotFromSession(ctx).items;
      await showItems(ctx, {
        title: "Notes",
        items,
        emptyText: "No notes yet. Ask the agent to add verified facts!",
        showProgress: false,
        showStableIds: true,
      });
    },
  });
}
