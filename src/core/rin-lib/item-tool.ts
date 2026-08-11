import { Type } from "typebox";

export type ItemAction = "read" | "add" | "edit" | "remove";

export const ITEM_ACTIONS: readonly ItemAction[] = [
  "read",
  "add",
  "edit",
  "remove",
];

export const ItemActionSchema = Type.Union(
  ITEM_ACTIONS.map((action) => Type.Literal(action)),
  {
    description: "Item-level operation to perform.",
  },
);

const PositiveIdSchema = Type.Integer({
  minimum: 1,
  description: "Stable item ID returned by a read.",
});

export function createItemToolParameters(
  addItemSchema: any,
  editItemSchema: any,
) {
  return Type.Object(
    {
      action: ItemActionSchema,
      offset: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "1-based item position to start reading from. Read only; omit to start at the first item.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "Maximum number of items to return. Read only; omit to return every remaining item.",
        }),
      ),
      items: Type.Optional(
        Type.Array(addItemSchema, {
          minItems: 1,
          description: "One or more items to add in the supplied order.",
        }),
      ),
      beforeId: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "Insert added items immediately before this stable ID. Omit to append.",
        }),
      ),
      id: Type.Optional(PositiveIdSchema),
      item: Type.Optional(editItemSchema),
      ids: Type.Optional(
        Type.Array(PositiveIdSchema, {
          minItems: 1,
          description: "One or more stable IDs to remove atomically.",
        }),
      ),
      all: Type.Optional(
        Type.Boolean({
          description: "Set to true with remove to clear every item.",
        }),
      ),
    },
    { additionalProperties: false },
  );
}

export function normalizeItemId(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/^#/, "");
  if (!/^\d+$/.test(normalized)) return undefined;
  const id = Number(normalized);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function normalizeNextItemId(
  items: ReadonlyArray<{ id: number }>,
  value: unknown,
) {
  const next = Number(value);
  const minimum = Math.max(0, ...items.map((item) => item.id)) + 1;
  return Number.isSafeInteger(next) && next >= minimum ? next : minimum;
}

const ACTION_FIELDS: Record<ItemAction, Set<string>> = {
  read: new Set(["action", "offset", "limit"]),
  add: new Set(["action", "items", "beforeId"]),
  edit: new Set(["action", "id", "item"]),
  remove: new Set(["action", "ids", "all"]),
};

export function validateItemActionParams(params: unknown): {
  action?: ItemAction;
  error?: string;
} {
  const value = params && typeof params === "object" ? (params as any) : null;
  if (!value) return { error: "action is required" };
  const action = value.action as ItemAction;
  if (!ITEM_ACTIONS.includes(action)) {
    return { error: "action must be read, add, edit, or remove" };
  }
  const unexpected = Object.keys(value).filter(
    (key) => !ACTION_FIELDS[action].has(key),
  );
  if (unexpected.length > 0) {
    return {
      action,
      error: `${action} does not accept: ${unexpected.join(", ")}`,
    };
  }
  if (action === "read") {
    for (const field of ["offset", "limit"] as const) {
      const input = value[field];
      if (
        input !== undefined &&
        (!Number.isSafeInteger(input) || Number(input) < 1)
      ) {
        return { action, error: `${field} must be a positive integer` };
      }
    }
  }
  return { action };
}

export type ItemReadWindow<T> = {
  items: T[];
  ranged: boolean;
  offset?: number;
  total?: number;
};

export function resolveItemReadWindow<T>(
  items: ReadonlyArray<T>,
  params: { offset?: number; limit?: number },
): ItemReadWindow<T> {
  const ranged = params.offset !== undefined || params.limit !== undefined;
  if (!ranged) return { items: [...items], ranged: false };

  const offset = params.offset ?? 1;
  const start = offset - 1;
  const limit = params.limit ?? Math.max(items.length - start, 0);
  const selected = items.slice(start, start + limit);
  return {
    items: selected,
    ranged: true,
    offset,
    total: items.length,
  };
}

export function formatItemReadWindowLabel(
  window: Pick<ItemReadWindow<unknown>, "items" | "offset" | "total">,
) {
  const offset = window.offset ?? 1;
  const total = window.total ?? window.items.length;
  if (window.items.length === 0) {
    return `No items at offset ${offset} (${total} total)`;
  }
  return `Items ${offset}-${offset + window.items.length - 1} of ${total}`;
}

export function formatItemReadWindowContent<T>(
  window: ItemReadWindow<T>,
  formatItems: (items: ReadonlyArray<T>) => string,
) {
  const body = formatItems(window.items);
  if (!window.ranged) return body;
  const label = formatItemReadWindowLabel(window);
  return window.items.length > 0 ? `${label}\n${body}` : label;
}

export function resolveInsertIndex(
  items: ReadonlyArray<{ id: number }>,
  beforeId: unknown,
): { index?: number; error?: string } {
  if (beforeId === undefined) return { index: items.length };
  const id = normalizeItemId(beforeId);
  if (id === undefined) return { error: "beforeId must be a positive integer" };
  const index = items.findIndex((item) => item.id === id);
  return index >= 0
    ? { index }
    : { error: `insertion anchor #${id} not found` };
}

export function resolveRemovalIds(
  params: any,
  items: ReadonlyArray<{ id: number }>,
): { clear?: boolean; ids?: number[]; error?: string } {
  if (params.all === true) {
    if (params.ids !== undefined) {
      return { error: "remove accepts either ids or all, not both" };
    }
    return { clear: true, ids: items.map((item) => item.id) };
  }
  if (params.all !== undefined) {
    return { error: "all must be true when provided" };
  }
  if (!Array.isArray(params.ids) || params.ids.length === 0) {
    return { error: "remove requires one or more ids, or all: true" };
  }
  const ids: number[] = [];
  for (const value of params.ids) {
    const id = normalizeItemId(value);
    if (id === undefined) return { error: "ids must be positive integers" };
    if (!ids.includes(id)) ids.push(id);
  }
  const missing = ids.filter((id) => !items.some((item) => item.id === id));
  if (missing.length > 0) {
    return {
      error: `${missing.map((id) => `#${id}`).join(", ")} not found`,
    };
  }
  return { ids };
}
