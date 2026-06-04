import {
  CHRONICLE_TAG,
  SelfImproveDoc,
  SelfImproveEvent,
} from "./core/types.js";
import {
  cjkBigrams,
  conceptTokens,
  normalizeList,
  normalizeNeedle,
  nowIso,
  safeString,
  trimText,
  uniqueStrings,
} from "./core/utils.js";

const QUERY_TOKEN_SPLIT_RE = /[^\p{Letter}\p{Number}_-]+/gu;
const RECENT_HISTORY_QUERY_RE =
  /(history|timeline|recent|what happened|why did we|just now)/i;

type NormalizedRelevanceQuery = {
  normalized: string;
  tokens: string[];
  cjkTokens: string[];
};

function normalizeRelevanceQuery(query: string): NormalizedRelevanceQuery {
  const normalized = normalizeNeedle(query);
  return {
    normalized,
    tokens: normalized
      .split(QUERY_TOKEN_SPLIT_RE)
      .filter((item) => item.length >= 2),
    cjkTokens: cjkBigrams(normalized),
  };
}

function normalizeHaystack(parts: Array<string | undefined>): string {
  return normalizeNeedle(parts.filter(Boolean).join(" \n "));
}

function normalizeDocTags(doc: Partial<SelfImproveDoc>): string[] {
  return normalizeList(doc?.tags);
}

function normalizeDocAliases(doc: Partial<SelfImproveDoc>): string[] {
  return normalizeList(doc?.aliases);
}

function normalizeEventTags(event: Partial<SelfImproveEvent>): string[] {
  return normalizeList(event?.tags);
}

function normalizeFeatureValues(values: string[]): string[] {
  return uniqueStrings(
    values.map((item) => normalizeNeedle(item)).filter(Boolean),
  );
}

function sharedNormalizedDocTags(
  a: Partial<SelfImproveDoc>,
  b: Partial<SelfImproveDoc>,
) {
  const bTagSet = new Set(normalizeFeatureValues(normalizeDocTags(b)));
  return normalizeFeatureValues(normalizeDocTags(a)).filter((tag) =>
    bTagSet.has(tag),
  );
}

function normalizeEventAgeHours(value: unknown): number {
  const timestamp = Date.parse(safeString(value).trim() || nowIso());
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, (Date.now() - timestamp) / 3_600_000);
}

function scoreTextMatches(
  query: NormalizedRelevanceQuery,
  haystack: string,
  weights: {
    exact: number;
    longToken: number;
    shortToken: number;
    cjkBigram: number;
  },
): number {
  if (!query.normalized || !haystack) return 0;
  let score = 0;
  if (haystack.includes(query.normalized)) score += weights.exact;
  for (const token of query.tokens) {
    if (haystack.includes(token)) {
      score += token.length >= 4 ? weights.longToken : weights.shortToken;
    }
  }
  for (const token of query.cjkTokens) {
    if (haystack.includes(token)) score += weights.cjkBigram;
  }
  return score;
}

export function lexicalScore(query: string, doc: SelfImproveDoc): number {
  const normalizedQuery = normalizeRelevanceQuery(query);
  const tags = normalizeDocTags(doc);
  const aliases = normalizeDocAliases(doc);
  const haystack = normalizeHaystack([
    safeString(doc?.name),
    safeString(doc?.description),
    safeString(doc?.content),
    safeString(doc?.id),
    safeString(doc?.self_improve_prompt_slot),
    safeString(doc?.scope),
    safeString(doc?.kind),
    ...tags,
    ...aliases,
  ]);
  if (!normalizedQuery.normalized || !haystack) return 0;
  let score = scoreTextMatches(normalizedQuery, haystack, {
    exact: 6,
    longToken: 1.2,
    shortToken: 0.6,
    cjkBigram: 0.45,
  });
  if (safeString(doc?.id) === normalizedQuery.normalized) score += 6;
  if (safeString(doc?.self_improve_prompt_slot) === normalizedQuery.normalized)
    score += 6;
  if (doc?.exposure === "self_improve_prompts") score += 0.2;
  if (doc?.status !== "active") score -= 8;
  if (tags.includes(CHRONICLE_TAG) && !shouldInjectRecentHistory(query)) {
    score -= 1.4;
  }
  return score;
}

export function eventScore(query: string, event: SelfImproveEvent): number {
  const normalizedQuery = normalizeRelevanceQuery(query);
  const haystack = normalizeHaystack([
    safeString(event?.kind),
    safeString(event?.summary),
    safeString(event?.text),
    safeString(event?.tool_name),
    ...normalizeEventTags(event),
  ]);
  if (!normalizedQuery.normalized || !haystack) return 0;
  let score = scoreTextMatches(normalizedQuery, haystack, {
    exact: 5,
    longToken: 1,
    shortToken: 0.5,
    cjkBigram: 0.35,
  });
  const ageHours = normalizeEventAgeHours(event?.created_at);
  score += Math.max(0, 2 - ageHours / 24);
  return score;
}

export function excerptForRecall(
  doc: SelfImproveDoc,
  query: string,
  max = 240,
): string {
  const text = [doc.description, doc.content]
    .filter(Boolean)
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const q = safeString(query).trim().toLowerCase();
  if (!q || text.length <= max) return trimText(text, max);
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return trimText(text, max);
  const start = Math.max(0, idx - Math.floor(max / 3));
  const end = Math.min(text.length, start + max);
  const slice = text.slice(start, end).trim();
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}

function selfImproveRelationFeatures(doc: SelfImproveDoc): string[] {
  const contentSample = safeString(doc?.content)
    .split(/\n+/)
    .slice(0, 12)
    .join("\n");
  return uniqueStrings(
    [
      ...conceptTokens(safeString(doc?.name)),
      ...conceptTokens(safeString(doc?.description)),
      ...conceptTokens(contentSample),
      ...normalizeFeatureValues(normalizeDocTags(doc)),
      ...normalizeFeatureValues(normalizeDocAliases(doc)),
      normalizeNeedle(safeString(doc?.scope)),
      normalizeNeedle(safeString(doc?.kind)),
    ].filter(Boolean),
  );
}

export function relationScore(
  a: SelfImproveDoc,
  b: SelfImproveDoc,
): { score: number; reason: string } {
  const aFeatures = new Set(selfImproveRelationFeatures(a));
  const bFeatures = new Set(selfImproveRelationFeatures(b));
  let overlap = 0;
  for (const feature of aFeatures) {
    if (bFeatures.has(feature)) overlap += 1;
  }
  const sharedTags = sharedNormalizedDocTags(a, b);
  let score = Math.min(6, overlap) * 0.7 + sharedTags.length * 1.3;
  if (safeString(a?.scope) && a.scope === b.scope) score += 0.5;
  if (safeString(a?.kind) && a.kind === b.kind) score += 0.35;
  if (a?.exposure !== b?.exposure) score += 0.25;
  const reason = sharedTags.length
    ? "shared-tags"
    : overlap >= 3
      ? "shared-concepts"
      : a.scope === b.scope
        ? "shared-scope"
        : a.kind === b.kind
          ? "shared-kind"
          : "";
  return { score, reason };
}

export function shouldInjectRecentHistory(query: string): boolean {
  return RECENT_HISTORY_QUERY_RE.test(safeString(query));
}

export function activeDocsOnly(docs: SelfImproveDoc[]): SelfImproveDoc[] {
  return Array.isArray(docs)
    ? docs.filter((doc) => doc?.status === "active")
    : [];
}
