import { safeString } from "../text-utils.js";
import { normalizeItemId, normalizeNextItemId } from "./item-tool.js";

export type RinNoteItem = {
  id: number;
  text: string;
};

export type RinNoteSnapshot = {
  items: RinNoteItem[];
  nextId: number;
};

export const RIN_NOTE_CUSTOM_ENTRY_TYPE = "rin.note";

export function normalizeRinNoteItem(value: unknown): RinNoteItem | undefined {
  const item = value && typeof value === "object" ? (value as any) : null;
  if (!item) return undefined;
  const id = normalizeItemId(item.id);
  const text = safeString(item.text).trim();
  if (id === undefined || !text) return undefined;
  return { id, text };
}

function snapshot(
  items: RinNoteItem[] = [],
  nextId?: unknown,
): RinNoteSnapshot {
  const cloned = items.map((item) => ({ ...item }));
  return {
    items: cloned,
    nextId: normalizeNextItemId(cloned, nextId),
  };
}

function snapshotFromCustomEntry(entry: unknown): RinNoteSnapshot | undefined {
  const value = entry && typeof entry === "object" ? (entry as any) : null;
  if (
    !value ||
    value.type !== "custom" ||
    safeString(value.customType).trim() !== RIN_NOTE_CUSTOM_ENTRY_TYPE
  ) {
    return undefined;
  }
  const data = value.data && typeof value.data === "object" ? value.data : {};
  if (Array.isArray((data as any).items)) {
    const items: RinNoteItem[] = [];
    for (const raw of (data as any).items) {
      const item = normalizeRinNoteItem(raw);
      if (item) items.push(item);
    }
    return snapshot(items, (data as any).nextId);
  }

  // Legacy text-buffer snapshots migrate losslessly enough for item semantics:
  // the complete non-empty buffer becomes one item on first reconstruction.
  if (typeof (data as any).content === "string") {
    const text = (data as any).content.trim();
    return snapshot(text ? [{ id: 1, text }] : [], text ? 2 : 1);
  }
  return undefined;
}

export function readNoteSnapshotFromSession(session: any): RinNoteSnapshot {
  let branch: any[] = [];
  try {
    const candidate = session?.sessionManager?.getBranch?.();
    if (Array.isArray(candidate)) branch = candidate;
  } catch {
    return snapshot();
  }

  let latest = snapshot();
  for (const entry of branch) {
    const next = snapshotFromCustomEntry(entry);
    if (next) latest = next;
  }
  return latest;
}
