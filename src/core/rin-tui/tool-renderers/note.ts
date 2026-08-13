import type { NoteToolDetails } from "../../rin-lib/core-tool-contracts.js";
import {
  fallbackItemToolResult,
  renderItemToolCall,
  updateItemToolText,
} from "./item.js";

function parseNoteItems(value: unknown): NoteToolDetails["items"] | undefined {
  const details = value as Partial<NoteToolDetails> | undefined;
  return Array.isArray(details?.items) ? details.items : undefined;
}

function formatNotes(items: NoteToolDetails["items"], theme: any) {
  if (items.length === 0) return theme.fg("dim", "○ No notes");
  return items
    .map(
      (item) =>
        `${theme.fg("accent", `#${item.id}`)} ${theme.fg("text", item.text)}`,
    )
    .join("\n");
}

export const noteToolRenderer = {
  name: "note",
  renderCall(args: any, theme: any, context: any) {
    return renderItemToolCall("note", args, theme, context);
  },
  renderResult(value: any, _options: any, theme: any, context: any) {
    const items = parseNoteItems(value?.details);
    if (!items) return fallbackItemToolResult(value, context);
    const notes = formatNotes(items, theme);
    const error =
      typeof value.details?.error === "string" ? value.details.error : "";
    return updateItemToolText(
      error
        ? [theme.fg("error", `Error: ${error}`), notes]
            .filter(Boolean)
            .join("\n")
        : notes,
      context,
    );
  },
};
