import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

import { normalizeSessionRef } from "../session/ref.js";

function normalizeRpcText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function normalizePendingMessageCount(value: unknown) {
  const count = Number(value);
  if (!Number.isFinite(count)) return 0;
  return Math.max(0, Math.trunc(count));
}

function normalizeRpcEntries(entries: any[]) {
  return entries.flatMap((entry: any) => {
    const id = normalizeRpcText(entry?.id);
    if (!id) return [];
    const parentId = normalizeRpcText(entry?.parentId);
    const { parentId: _ignoredParentId, ...rest } = entry ?? {};
    return [
      {
        ...rest,
        id,
        ...(parentId ? { parentId } : {}),
      },
    ];
  });
}

function entryHasParentCycle(entry: any, nodeById: Map<string, any>) {
  const originId = normalizeRpcText(entry?.id);
  if (!originId) return false;
  const visited = new Set<string>([originId]);
  let parentId = normalizeRpcText(entry?.parentId);
  while (parentId) {
    if (visited.has(parentId)) return true;
    visited.add(parentId);
    const parent = nodeById.get(parentId)?.entry;
    if (!parent) return false;
    parentId = normalizeRpcText(parent.parentId);
  }
  return false;
}

function buildRpcTreeFromEntries(
  entries: any[],
  labelsById: Map<string, string | undefined>,
) {
  const nodeById = new Map<string, any>();
  const labelTimestampsById = new Map<string, string | undefined>();
  const roots: any[] = [];

  for (const entry of entries) {
    nodeById.set(entry.id, { entry, children: [] });
    if (entry.type !== "label") continue;
    const targetId = normalizeRpcText(entry.targetId);
    if (!targetId) continue;
    const label = normalizeRpcText(entry.label);
    if (label) {
      labelsById.set(targetId, label);
      labelTimestampsById.set(targetId, normalizeRpcText(entry.timestamp));
    } else {
      labelsById.delete(targetId);
      labelTimestampsById.delete(targetId);
    }
  }

  for (const entry of entries) {
    const node = nodeById.get(entry.id);
    if (!node) continue;
    const label = labelsById.get(entry.id);
    if (label) {
      node.label = label;
      node.labelTimestamp = labelTimestampsById.get(entry.id);
    }
    const parentId = normalizeRpcText(entry.parentId);
    if (!parentId || parentId === entry.id) {
      roots.push(node);
      continue;
    }
    const parent = nodeById.get(parentId);
    if (parent && !entryHasParentCycle(entry, nodeById)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const stack = [...roots];
  while (stack.length) {
    const node = stack.pop()!;
    node.children.sort(
      (left: any, right: any) =>
        new Date(left.entry.timestamp).getTime() -
        new Date(right.entry.timestamp).getTime(),
    );
    stack.push(...node.children);
  }

  return roots;
}

function normalizeRpcTree(
  nodes: any[],
  entryById: Map<string, any>,
  labelsById: Map<string, string | undefined>,
) {
  const normalizedRoots: any[] = [];
  const stack = [...nodes]
    .reverse()
    .map((node) => ({ node, output: normalizedRoots }));

  while (stack.length) {
    const { node, output } = stack.pop()!;
    const entryId = normalizeRpcText(node?.entry?.id);
    if (!entryId) continue;
    const entry = entryById.get(entryId);
    if (!entry) continue;
    labelsById.set(
      entryId,
      typeof node?.label === "string" ? node.label : undefined,
    );

    const normalizedNode = {
      ...node,
      entry,
      children: [] as any[],
    };
    output.push(normalizedNode);

    const children = Array.isArray(node?.children) ? node.children : [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], output: normalizedNode.children });
    }
  }

  return normalizedRoots;
}

export function applyRpcSessionState(
  target: {
    model: any;
    thinkingLevel: ThinkingLevel;
    steeringMode: "all" | "one-at-a-time";
    followUpMode: "all" | "one-at-a-time";
    isStreaming: boolean;
    isCompacting: boolean;
    pendingMessageCount: number;
    autoCompactionEnabled: boolean;
    sessionId: string;
    sessionFile?: string;
    sessionName?: string;
    state: any;
    activeTurn?: unknown;
    remoteTurnRunning?: boolean;
    setRemoteTurnRunning?: (running: boolean) => void;
  },
  state: any,
) {
  const { sessionId, sessionFile } = normalizeSessionRef(state);

  target.model = state?.model ?? null;
  target.thinkingLevel = state?.thinkingLevel ?? target.thinkingLevel;
  target.steeringMode = state?.steeringMode ?? target.steeringMode;
  target.followUpMode = state?.followUpMode ?? target.followUpMode;
  target.autoCompactionEnabled = Boolean(state?.autoCompactionEnabled);
  // The worker owns authoritative turn activity. `isStreaming` is the lower-
  // level session flag and may drop during internal checkpoints such as
  // compaction, while `turnActive` tracks the whole in-flight turn.
  const nextRemoteTurnRunning = Boolean(
    state?.turnActive ?? state?.isStreaming,
  );
  if (!nextRemoteTurnRunning && target.remoteTurnRunning) {
    target.activeTurn = null;
  }
  if (typeof target.setRemoteTurnRunning === "function") {
    target.setRemoteTurnRunning(nextRemoteTurnRunning);
  } else {
    target.isStreaming = nextRemoteTurnRunning;
  }
  target.isCompacting = Boolean(state?.isCompacting);
  target.pendingMessageCount = normalizePendingMessageCount(
    state?.pendingMessageCount,
  );
  target.sessionId = sessionId || "";
  target.sessionFile = sessionFile;
  target.sessionName = normalizeRpcText(state?.sessionName);
  target.state.model = target.model;
  target.state.thinkingLevel = target.thinkingLevel;
}

export function applyRpcMessages(
  target: { messages: any[]; state: any },
  data: any,
) {
  target.messages = Array.isArray(data?.messages) ? data.messages : [];
  target.state.messages = target.messages;
}

export function applyRpcSessionTree(
  target: {
    entries: any[];
    tree: any[];
    leafId: string | null;
    entryById: Map<string, any>;
    labelsById: Map<string, string | undefined>;
  },
  entriesData: any,
  treeData: any,
) {
  target.entries = normalizeRpcEntries(
    Array.isArray(entriesData?.entries) ? entriesData.entries : [],
  );
  target.entryById = new Map(
    target.entries.map((entry: any) => [entry.id, entry]),
  );
  target.labelsById = new Map();
  const snapshotTree = Array.isArray(treeData?.tree) ? treeData.tree : [];
  target.tree = snapshotTree.length
    ? normalizeRpcTree(snapshotTree, target.entryById, target.labelsById)
    : buildRpcTreeFromEntries(target.entries, target.labelsById);
  const leafId = normalizeRpcText(treeData?.leafId);
  target.leafId = leafId && target.entryById.has(leafId) ? leafId : null;
}

export function getSessionBranch(
  entryById: Map<string, any>,
  leafId: string | null,
  fromId?: string,
) {
  const targetId = normalizeRpcText(fromId ?? leafId);
  if (!targetId) return [];
  const branch: any[] = [];
  const visited = new Set<string>();
  let currentId: string | undefined = targetId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const current = entryById.get(currentId);
    if (!current) break;
    branch.push(current);
    currentId = normalizeRpcText(current.parentId);
  }
  return branch.reverse();
}
