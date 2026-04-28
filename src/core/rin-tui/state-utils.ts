import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

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

function normalizeRpcTree(
  nodes: any[],
  entryById: Map<string, any>,
  labelsById: Map<string, string | undefined>,
) {
  return nodes.flatMap((node: any) => {
    const entryId = normalizeRpcText(node?.entry?.id);
    if (!entryId) return [];
    const entry = entryById.get(entryId);
    if (!entry) return [];
    labelsById.set(
      entryId,
      typeof node?.label === "string" ? node.label : undefined,
    );
    return [
      {
        ...node,
        entry,
        children: normalizeRpcTree(
          Array.isArray(node?.children) ? node.children : [],
          entryById,
          labelsById,
        ),
      },
    ];
  });
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
  target.tree = normalizeRpcTree(
    Array.isArray(treeData?.tree) ? treeData.tree : [],
    target.entryById,
    target.labelsById,
  );
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
