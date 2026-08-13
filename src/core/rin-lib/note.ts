/**
 * Rin core note capability.
 *
 * Verified continuity is stored as stable-ID items scoped to the selected
 * session branch. Snapshots survive compaction without becoming cross-session
 * memory.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  RinCapabilityContext,
  RinCapabilityDefinition,
} from "./capability-types.js";
import {
  createItemToolParameters,
  formatItemReadWindowContent,
  normalizeItemId,
  normalizeNextItemId,
  resolveInsertIndex,
  resolveItemReadWindow,
  resolveSelectedItemIds,
  type ItemAction,
  type ItemReadWindow,
  updateItemToolText,
  validateItemActionParams,
} from "./item-tool.js";
import {
  readNoteSnapshotFromSession,
  RIN_NOTE_CUSTOM_ENTRY_TYPE,
  type RinNoteItem,
} from "./note-state.js";

export { RIN_NOTE_CUSTOM_ENTRY_TYPE } from "./note-state.js";
export { readNoteSnapshotFromSession } from "./note-state.js";

interface NoteDetails {
  action: ItemAction;
  items: RinNoteItem[];
  nextId: number;
  error?: string;
}

const NoteAddItemParams: any = Type.Object(
  {
    text: Type.String({
      minLength: 1,
      description:
        "Shortest verified content that must survive compaction exactly.",
    }),
  },
  { additionalProperties: false },
);

const NoteEditItemParams: any = Type.Object(
  {
    text: Type.String({
      minLength: 1,
      description:
        "Shortest complete replacement that must survive compaction exactly.",
    }),
  },
  { additionalProperties: false },
);

const NOTE_ACTIONS: readonly ItemAction[] = [
  "read",
  "add",
  "edit",
  "remove",
  "clear",
];

const NoteParams: any = createItemToolParameters(
  NoteAddItemParams,
  NoteEditItemParams,
  { actions: NOTE_ACTIONS },
);

function normalizeAddItems(
  value: unknown,
): Array<{ text: string }> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const items: Array<{ text: string }> = [];
  for (const raw of value) {
    const item = raw && typeof raw === "object" ? (raw as any) : null;
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (!text || Object.keys(item).some((key) => key !== "text")) {
      return undefined;
    }
    items.push({ text });
  }
  return items;
}

function normalizeEdit(value: unknown): { text: string } | undefined {
  const item = value && typeof value === "object" ? (value as any) : null;
  if (!item || Object.keys(item).some((key) => key !== "text")) {
    return undefined;
  }
  const text = typeof item.text === "string" ? item.text.trim() : "";
  return text ? { text } : undefined;
}

function formatNoteContent(items: RinNoteItem[]) {
  if (items.length === 0) return "No notes";
  return items.map((item) => `#${item.id} ${item.text}`).join("\n");
}

function formatNoteRender(items: RinNoteItem[], theme: Theme) {
  if (items.length === 0) return theme.fg("dim", "○ No notes");
  return items
    .map(
      (item) =>
        `${theme.fg("accent", `#${item.id}`)} ${theme.fg("text", item.text)}`,
    )
    .join("\n");
}

function parseDetails(value: unknown): NoteDetails | undefined {
  const details = value && typeof value === "object" ? (value as any) : null;
  if (!details || !Array.isArray(details.items)) return undefined;
  const items = details.items
    .map((item: any) => {
      const id = normalizeItemId(item?.id);
      const text = typeof item?.text === "string" ? item.text.trim() : "";
      return id === undefined || !text ? undefined : { id, text };
    })
    .filter((item: RinNoteItem | undefined): item is RinNoteItem =>
      Boolean(item),
    );
  const action = NOTE_ACTIONS.includes(details.action)
    ? details.action
    : "read";
  return {
    action,
    items,
    nextId: normalizeNextItemId(items, details.nextId),
    ...(typeof details.error === "string" ? { error: details.error } : {}),
  };
}

export default function noteCapability(): RinCapabilityDefinition {
  let items: RinNoteItem[] = [];
  let nextId = 1;
  let activeSessionManager: any;

  const details = (
    action: ItemAction,
    error?: string,
    readWindow?: ItemReadWindow<RinNoteItem>,
  ): NoteDetails => ({
    action,
    items: (readWindow?.items ?? items).map((item) => ({ ...item })),
    nextId,
    ...(error ? { error } : {}),
  });

  const result = (
    action: ItemAction,
    error?: string,
    readWindow?: ItemReadWindow<RinNoteItem>,
  ) => ({
    content: [
      {
        type: "text" as const,
        text: error
          ? `Error: ${error}`
          : formatItemReadWindowContent(
              readWindow ?? { items, ranged: false },
              formatNoteContent,
            ),
      },
    ],
    details: details(action, error, readWindow),
  });

  const persist = (nextItems: RinNoteItem[], nextItemId: number) => {
    const appendCustomEntry = activeSessionManager?.appendCustomEntry;
    if (typeof appendCustomEntry !== "function") {
      throw new Error("session custom entries are not available");
    }
    appendCustomEntry.call(activeSessionManager, RIN_NOTE_CUSTOM_ENTRY_TYPE, {
      items: nextItems.map((item) => ({ ...item })),
      nextId: nextItemId,
    });
    items = nextItems;
    nextId = nextItemId;
  };

  const commit = (
    action: ItemAction,
    nextItems: RinNoteItem[],
    nextItemId: number,
  ) => {
    try {
      persist(nextItems, nextItemId);
      return result(action);
    } catch (error: any) {
      return result(
        action,
        `failed to persist note state: ${String(error?.message || error)}`,
      );
    }
  };

  const reconstructState = (ctx: RinCapabilityContext) => {
    activeSessionManager = ctx.sessionManager;
    const state = readNoteSnapshotFromSession({
      sessionManager: activeSessionManager,
    });
    items = state.items.map((item) => ({ ...item }));
    nextId = state.nextId;
  };

  const tool: any = {
    name: "note",
    label: "Notes",
    description:
      "Maintain a minimal scratchpad of verified content that must survive compaction exactly as stable-ID items scoped to the session branch. Read returns every item by default or a 1-based offset/limit range; add accepts one or more items and can insert before an ID; edit replaces one item; remove deletes selected IDs; clear removes every item.",
    promptSnippet:
      "Session-branch scratchpad for exact cross-compaction state.",
    promptGuidelines: [
      "Use note when minimal verified state must survive compaction exactly; use todo for execution checklists and files or tools for recoverable context.",
    ],
    parameters: NoteParams,

    async execute(_toolCallId: string, params: any, signal?: AbortSignal) {
      const validated = validateItemActionParams(params, NOTE_ACTIONS);
      const action = validated.action ?? "read";
      if (validated.error) return result(action, validated.error);
      if (action === "read") {
        return result("read", undefined, resolveItemReadWindow(items, params));
      }
      if (signal?.aborted) return result(action, "operation aborted");

      if (action === "add") {
        const additions = normalizeAddItems(params.items);
        if (!additions) {
          return result("add", "add requires one or more valid note items");
        }
        const insertion = resolveInsertIndex(items, params.beforeId);
        if (insertion.error) return result("add", insertion.error);
        let allocatedId = nextId;
        const added = additions.map((item) => ({ id: allocatedId++, ...item }));
        const nextItems = items.map((item) => ({ ...item }));
        nextItems.splice(insertion.index!, 0, ...added);
        return commit("add", nextItems, allocatedId);
      }

      if (action === "edit") {
        const id = normalizeItemId(params.id);
        const edit = normalizeEdit(params.item);
        if (id === undefined || !edit) {
          return result(
            "edit",
            "edit requires one valid id and one replacement note item",
          );
        }
        const index = items.findIndex((item) => item.id === id);
        if (index < 0) return result("edit", `#${id} not found`);
        const nextItems = items.map((item) => ({ ...item }));
        nextItems[index] = { id, text: edit.text };
        return commit("edit", nextItems, nextId);
      }

      if (action === "clear") {
        return commit("clear", [], 1);
      }

      const removal = resolveSelectedItemIds("remove", params, items);
      if (removal.error) return result("remove", removal.error);
      const nextItems = items
        .filter((item) => !removal.ids!.includes(item.id))
        .map((item) => ({ ...item }));
      return commit("remove", nextItems, nextId);
    },

    renderCall(args: any, theme: Theme, context: any) {
      const action = String(args?.action || "").trim();
      return updateItemToolText(
        context?.isPartial === false
          ? ""
          : theme.fg("toolTitle", action ? `note ${action}` : "note …"),
        context,
      );
    },

    renderResult(value: any, _options: any, theme: Theme, context: any) {
      const parsed = parseDetails(value.details);
      if (!parsed) {
        const text = value.content?.[0];
        return updateItemToolText(
          text?.type === "text" ? text.text : "",
          context,
        );
      }
      const notes = formatNoteRender(parsed.items, theme);
      return updateItemToolText(
        parsed.error
          ? [theme.fg("error", `Error: ${parsed.error}`), notes]
              .filter(Boolean)
              .join("\n")
          : notes,
        context,
      );
    },
  };

  return {
    name: "note",
    tools: [tool],
    hooks: {
      session_start: [async (_event, ctx) => reconstructState(ctx)],
      session_tree: [async (_event, ctx) => reconstructState(ctx)],
    },
  };
}
