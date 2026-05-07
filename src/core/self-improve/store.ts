import fs from "node:fs/promises";
import fssync from "node:fs";

import { MemoryDoc, MEMORY_PROMPT_SLOTS } from "./core/types.js";
import {
  ensureFidelity,
  ensureKind,
  ensureScope,
  ensureStatus,
  previewMemoryDoc,
} from "./core/schema.js";
import { compileFromDocsAndEvents } from "./compile.js";
import {
  assertMemoryPromptDoc,
  loadMemoryDocs,
  loadMemoryDocsSync,
  memoryPromptPath,
  writeMemoryDoc,
} from "./docs.js";
import { activeDocsOnly } from "./relevance.js";
import { normalizePromptListContent } from "./processing.js";
import { normalizeList, nowIso, safeString, slugify } from "./core/utils.js";
import {
  resolveSelfImproveRoot,
  selfImproveEventMemorySkillsDir,
  selfImproveMemoryIndexSkillsDir,
  selfImprovePromptsDir,
  selfImproveSkillsDir,
  selfImproveStateDir,
} from "./paths.js";

export { resolveSelfImproveRoot } from "./paths.js";

export async function ensureSelfImproveLayout(
  rootOverride = "",
): Promise<string> {
  const rootDir = resolveSelfImproveRoot(rootOverride);
  await fs.mkdir(rootDir, { recursive: true });
  await Promise.all(
    [
      selfImprovePromptsDir(rootOverride),
      selfImproveSkillsDir(rootOverride),
      selfImproveMemoryIndexSkillsDir(rootOverride),
      selfImproveEventMemorySkillsDir(rootOverride),
      selfImproveStateDir(rootOverride),
    ].map((dir) => fs.mkdir(dir, { recursive: true })),
  );
  return rootDir;
}

export async function loadActiveSelfImproveDocs(rootOverride = "") {
  const root = await ensureSelfImproveLayout(rootOverride);
  return activeDocsOnly(await loadMemoryDocs(root));
}

export async function saveSelfImprovePromptDoc(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const root = await ensureSelfImproveLayout(rootOverride);
  const content = normalizePromptListContent(safeString(params.content || ""));
  if (!content) throw new Error("self_improve_content_required");
  const selfImprovePromptSlot = safeString(
    params.selfImprovePromptSlot || params.residentSlot || "",
  ).trim();
  const doc: MemoryDoc = {
    id:
      safeString(params.id || "").trim() ||
      slugify(selfImprovePromptSlot, selfImprovePromptSlot),
    name:
      safeString(params.name || "").trim() ||
      selfImprovePromptSlot.replace(/_/g, " ") ||
      "self-improve prompt",
    exposure: "self_improve_prompts",
    fidelity: ensureFidelity(safeString(params.fidelity || "exact")),
    self_improve_prompt_slot: selfImprovePromptSlot,
    description: safeString(params.description || "").trim(),
    tags: normalizeList(params.tags || []),
    aliases: normalizeList(params.aliases || []),
    scope: ensureScope(safeString(params.scope || "global")),
    kind: ensureKind(safeString(params.kind || "instruction")),
    sensitivity: safeString(params.sensitivity || "normal").trim() || "normal",
    source: safeString(params.source || "").trim(),
    updated_at: nowIso(),
    last_observed_at: nowIso(),
    observation_count: Math.max(1, Number(params.observationCount || 1) || 1),
    status: ensureStatus(safeString(params.status || "active")),
    supersedes: normalizeList(params.supersedes || []),
    canonical: true,
    path: memoryPromptPath(root, selfImprovePromptSlot),
    content,
  };
  assertMemoryPromptDoc(doc);
  await writeMemoryDoc(doc);
  return {
    status: "ok",
    action: "save_self_improve_prompt",
    doc: previewMemoryDoc(doc),
  };
}

export async function removeSelfImprovePromptDoc(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const root = await ensureSelfImproveLayout(rootOverride);
  const slot = safeString(
    params.selfImprovePromptSlot || params.residentSlot || "",
  ).trim();
  if (!MEMORY_PROMPT_SLOTS.includes(slot as any)) {
    throw new Error(
      `self_improve_prompt_slot_required:${MEMORY_PROMPT_SLOTS.join(",")}`,
    );
  }
  const targetPath = memoryPromptPath(root, slot);
  await fs.rm(targetPath, { force: true });
  return {
    status: "ok",
    action: "remove_self_improve_prompt",
    selfImprovePromptSlot: slot,
    path: targetPath,
  };
}

export async function compileSelfImprove(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const root = await ensureSelfImproveLayout(rootOverride);
  const docs = activeDocsOnly(await loadMemoryDocs(root));
  return compileFromDocsAndEvents(
    docs,
    [],
    { updated_at: "", edges: [] },
    params,
    root,
  );
}

export function compileSelfImproveSync(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const root = resolveSelfImproveRoot(rootOverride);
  if (!fssync.existsSync(root)) {
    return compileFromDocsAndEvents(
      [],
      [],
      { updated_at: "", edges: [] },
      params,
      root,
    );
  }
  const docs = activeDocsOnly(loadMemoryDocsSync(root));
  return compileFromDocsAndEvents(
    docs,
    [],
    { updated_at: "", edges: [] },
    params,
    root,
  );
}

export async function executeSelfImproveAction(
  params: Record<string, any> = {},
  rootOverride = "",
) {
  const action = safeString(params.action || "").trim();
  if (action === "save_self_improve_prompt") {
    return await saveSelfImprovePromptDoc(params, rootOverride);
  }
  if (action === "remove_self_improve_prompt") {
    return await removeSelfImprovePromptDoc(params, rootOverride);
  }
  if (action === "compile")
    return await compileSelfImprove(params, rootOverride);
  throw new Error(`unsupported_self_improve_action:${action}`);
}
