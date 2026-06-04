import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";

import {
  SelfImproveDoc,
  SELF_IMPROVE_PROMPT_LIMITS,
  SELF_IMPROVE_PROMPT_SLOTS,
} from "./core/types.js";
import { previewSelfImproveDoc } from "./core/schema.js";
import { nowIso, safeString } from "./core/utils.js";

export async function walkMarkdownFiles(dirPath: string): Promise<string[]> {
  if (!fssync.existsSync(dirPath)) return [];
  const out: string[] = [];
  const visit = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(fullPath);
    }
  };
  await visit(dirPath);
  return out.sort();
}

function selfImprovePromptsDir(rootDir: string) {
  return path.join(rootDir, "prompts");
}

function promptDocFromFile(
  filePath: string,
  text: string,
): SelfImproveDoc | null {
  const slot = path.basename(filePath, ".md").trim();
  if (!SELF_IMPROVE_PROMPT_SLOTS.includes(slot as any)) return null;
  const content = safeString(text).trim();
  if (!content) return null;
  const now = nowIso();
  return {
    id: slot.replace(/_/g, "-"),
    name: slot.replace(/_/g, " "),
    exposure: "self_improve_prompts",
    fidelity: "exact",
    self_improve_prompt_slot: slot,
    description: "",
    tags: [],
    aliases: [],
    scope: "global",
    kind: "instruction",
    sensitivity: "normal",
    source: "",
    updated_at: now,
    last_observed_at: now,
    observation_count: 1,
    status: "active",
    supersedes: [],
    canonical: true,
    path: filePath,
    content,
  };
}

export async function loadSelfImproveDocs(
  rootDir: string,
): Promise<SelfImproveDoc[]> {
  const files = await walkMarkdownFiles(selfImprovePromptsDir(rootDir));
  const docs: SelfImproveDoc[] = [];
  for (const filePath of files) {
    const doc = promptDocFromFile(
      filePath,
      await fs.readFile(filePath, "utf8"),
    );
    if (doc) docs.push(doc);
  }
  return docs;
}

export function loadSelfImproveDocsSync(rootDir: string): SelfImproveDoc[] {
  const docs: SelfImproveDoc[] = [];
  const visit = (dirPath: string) => {
    if (!fssync.existsSync(dirPath)) return;
    const entries = fssync.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const doc = promptDocFromFile(
            fullPath,
            fssync.readFileSync(fullPath, "utf8"),
          );
          if (doc) docs.push(doc);
        } catch {}
      }
    }
  };
  visit(selfImprovePromptsDir(rootDir));
  return docs.sort((a, b) =>
    safeString(a.path).localeCompare(safeString(b.path)),
  );
}

export async function resolveSelfImproveDoc(
  rootDir: string,
  query: string,
): Promise<SelfImproveDoc | null> {
  const raw = safeString(query).trim();
  if (!raw) return null;
  const abs = path.isAbsolute(raw) ? raw : path.join(rootDir, raw);
  if (fssync.existsSync(abs) && abs.endsWith(".md"))
    return promptDocFromFile(abs, await fs.readFile(abs, "utf8"));
  const docs = await loadSelfImproveDocs(rootDir);
  return (
    docs.find(
      (doc) => doc.id === raw || doc.self_improve_prompt_slot === raw,
    ) || null
  );
}

export function selfImprovePromptPath(rootDir: string, slot: string): string {
  return path.join(rootDir, "prompts", `${slot}.md`);
}

export function assertSelfImprovePromptDoc(doc: SelfImproveDoc): void {
  const slot = safeString(doc.self_improve_prompt_slot).trim();
  if (!SELF_IMPROVE_PROMPT_SLOTS.includes(slot as any)) {
    throw new Error(
      `self_improve_prompt_slot_required:${SELF_IMPROVE_PROMPT_SLOTS.join(",")}`,
    );
  }
  const limits = SELF_IMPROVE_PROMPT_LIMITS[slot];
  if (!limits) throw new Error(`self_improve_prompt_slot_invalid:${slot}`);
  if (!limits.fidelity.includes(doc.fidelity))
    throw new Error(
      `self_improve_prompt_fidelity_invalid:${slot}:${doc.fidelity}`,
    );
  const lineCount = safeString(doc.content)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
  if (lineCount > limits.maxLines)
    throw new Error(
      `self_improve_prompt_content_too_long:${slot}:${limits.maxLines}\nCompress existing lines, merge overlapping points, and keep only durable essentials.`,
    );
}

export async function writeSelfImproveDoc(doc: SelfImproveDoc) {
  await fs.mkdir(path.dirname(doc.path), { recursive: true });
  await fs.writeFile(doc.path, `${safeString(doc.content).trim()}\n`, "utf8");
}

export function previewDocs(docs: SelfImproveDoc[]) {
  return docs.map(previewSelfImproveDoc);
}
