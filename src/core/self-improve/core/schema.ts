import path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type {
  SelfImproveDoc,
  SelfImproveExposure,
  SelfImproveFidelity,
  SelfImproveKind,
  SelfImproveScope,
  SelfImproveStatus,
} from "./types.js";
import { nowIso, normalizeList, safeString, slugify } from "./utils.js";

export function ensureExposure(
  value: string,
  fallback: SelfImproveExposure = "self_improve_skills",
): SelfImproveExposure {
  const normalized = safeString(value).trim();
  if (normalized === "self_improve_prompts") return "self_improve_prompts";
  if (normalized === "self_improve_skills" || !normalized)
    return "self_improve_skills";
  return fallback;
}

export function ensureFidelity(
  value: string,
  fallback: SelfImproveFidelity = "fuzzy",
): SelfImproveFidelity {
  const normalized = safeString(value).trim();
  if (normalized === "exact" || normalized === "fuzzy") return normalized;
  return fallback;
}

export function ensureScope(
  value: string,
  fallback: SelfImproveScope = "project",
): SelfImproveScope {
  const normalized = safeString(value).trim();
  if (
    normalized === "global" ||
    normalized === "domain" ||
    normalized === "project" ||
    normalized === "session"
  )
    return normalized;
  return fallback;
}

export function ensureKind(
  value: string,
  fallback: SelfImproveKind = "fact",
): SelfImproveKind {
  const normalized = safeString(value).trim();
  if (
    normalized === "skill" ||
    normalized === "instruction" ||
    normalized === "rule" ||
    normalized === "fact" ||
    normalized === "index"
  )
    return normalized;
  if (
    normalized === "identity" ||
    normalized === "style" ||
    normalized === "method" ||
    normalized === "value" ||
    normalized === "preference"
  )
    return "instruction";
  if (normalized === "knowledge" || normalized === "history") return "fact";
  return fallback;
}

export function ensureStatus(
  value: string,
  fallback: SelfImproveStatus = "active",
): SelfImproveStatus {
  const normalized = safeString(value).trim();
  if (
    normalized === "active" ||
    normalized === "superseded" ||
    normalized === "invalidated"
  )
    return normalized;
  return fallback;
}

function frontmatterValue(raw: Record<string, any>, key: string): any {
  const metadata =
    raw && typeof raw.metadata === "object" && raw.metadata ? raw.metadata : {};
  if (raw[key] != null) return raw[key];
  if (metadata[key] != null) return metadata[key];
  return undefined;
}

export function normalizeFrontmatter(
  raw: Record<string, any>,
  filePath: string,
  content: string,
): SelfImproveDoc {
  const exposure = ensureExposure(
    safeString(frontmatterValue(raw, "exposure") || "self_improve_skills"),
  );
  const selfImprovePromptSlot = safeString(
    frontmatterValue(raw, "self_improve_prompt_slot") || "",
  ).trim();
  const name =
    safeString(raw.name || raw.title || "").trim() ||
    (selfImprovePromptSlot
      ? selfImprovePromptSlot.replace(/_/g, " ")
      : path.basename(filePath, ".md"));
  const id =
    safeString(frontmatterValue(raw, "id") || "").trim() ||
    slugify(name, path.basename(filePath, ".md"));
  return {
    id,
    name,
    exposure,
    fidelity: ensureFidelity(
      safeString(frontmatterValue(raw, "fidelity") || "fuzzy"),
    ),
    self_improve_prompt_slot: selfImprovePromptSlot,
    description: safeString(raw.description || raw.summary || "").trim(),
    tags: normalizeList(frontmatterValue(raw, "tags") || ""),
    aliases: normalizeList(frontmatterValue(raw, "aliases") || ""),
    scope: ensureScope(
      safeString(
        frontmatterValue(raw, "scope") ||
          (exposure === "self_improve_prompts" ? "global" : "project"),
      ),
    ),
    kind: ensureKind(
      safeString(
        frontmatterValue(raw, "kind") ||
          (exposure === "self_improve_prompts" ? "instruction" : "fact"),
      ),
    ),
    sensitivity:
      safeString(frontmatterValue(raw, "sensitivity") || "normal").trim() ||
      "normal",
    source: safeString(frontmatterValue(raw, "source") || "").trim(),
    updated_at:
      safeString(frontmatterValue(raw, "updated_at") || "").trim() || nowIso(),
    last_observed_at:
      safeString(
        frontmatterValue(raw, "last_observed_at") ||
          frontmatterValue(raw, "updated_at") ||
          "",
      ).trim() || nowIso(),
    observation_count: Math.max(
      1,
      Number(frontmatterValue(raw, "observation_count") || 1) || 1,
    ),
    status: ensureStatus(
      safeString(frontmatterValue(raw, "status") || "active"),
    ),
    supersedes: normalizeList(frontmatterValue(raw, "supersedes") || ""),
    canonical:
      frontmatterValue(raw, "canonical") == null
        ? exposure === "self_improve_prompts"
        : Boolean(frontmatterValue(raw, "canonical")),
    path: filePath,
    content,
  };
}

export function parseMarkdownDoc(
  filePath: string,
  text: string,
): SelfImproveDoc {
  const raw = safeString(text);
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return normalizeFrontmatter({}, filePath, raw.trim());
  let frontmatter: Record<string, any> = {};
  try {
    const parsed = parseYaml(match[1]);
    if (parsed && typeof parsed === "object")
      frontmatter = parsed as Record<string, any>;
  } catch {}
  return normalizeFrontmatter(
    frontmatter,
    filePath,
    safeString(match[2]).trim(),
  );
}

export function renderMarkdownDoc(doc: SelfImproveDoc): string {
  const fm = {
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    id: doc.id,
    exposure: doc.exposure,
    fidelity: doc.fidelity,
    ...(doc.self_improve_prompt_slot
      ? { self_improve_prompt_slot: doc.self_improve_prompt_slot }
      : {}),
    ...(doc.tags.length ? { tags: doc.tags } : {}),
    ...(doc.aliases.length ? { aliases: doc.aliases } : {}),
    ...(doc.scope ? { scope: doc.scope } : {}),
    ...(doc.kind ? { kind: doc.kind } : {}),
    ...(doc.sensitivity ? { sensitivity: doc.sensitivity } : {}),
    ...(doc.source ? { source: doc.source } : {}),
    updated_at: doc.updated_at || nowIso(),
    last_observed_at: doc.last_observed_at || doc.updated_at || nowIso(),
    observation_count: Math.max(1, Number(doc.observation_count || 1) || 1),
    status: doc.status || "active",
    ...(doc.supersedes.length ? { supersedes: doc.supersedes } : {}),
    canonical: Boolean(doc.canonical),
  };
  const yaml = stringifyYaml(fm).trim();
  return `---\n${yaml}\n---\n${safeString(doc.content).trim()}\n`;
}

export function previewSelfImproveDoc(
  doc: SelfImproveDoc,
): Record<string, any> {
  return {
    id: doc.id,
    name: doc.name,
    exposure: doc.exposure,
    fidelity: doc.fidelity,
    self_improve_prompt_slot: doc.self_improve_prompt_slot || undefined,
    description: doc.description || undefined,
    tags: doc.tags,
    aliases: doc.aliases,
    scope: doc.scope,
    kind: doc.kind,
    sensitivity: doc.sensitivity,
    source: doc.source || undefined,
    updated_at: doc.updated_at,
    last_observed_at: doc.last_observed_at,
    observation_count: doc.observation_count,
    status: doc.status,
    supersedes: doc.supersedes,
    canonical: doc.canonical,
    path: doc.path,
    preview: safeString(doc.content).trim().slice(0, 240),
  };
}
