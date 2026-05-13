import { safeString } from "./utils.js";
import type { ExternalMemoryResult } from "./transcript-types.js";

export function normalizeExternalMemoryLimit(value: unknown, fallback = 8) {
  return Math.max(1, Number(value || fallback) || fallback);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeExternalMessage(value: unknown) {
  if (!isRecord(value)) return null;
  const text = safeString(value.text || "").trim();
  if (!text) return null;
  const normalized = {
    ...value,
    role: safeString(value.role || "memory").trim() || "memory",
    timestamp: safeString(value.timestamp || "").trim(),
    line: Math.max(1, Number(value.line || 0) || 1),
    text,
  };
  const id = safeString(value.id || "").trim();
  const toolName = safeString(value.toolName || "").trim();
  return {
    ...normalized,
    ...(id ? { id } : {}),
    ...(toolName ? { toolName } : {}),
  };
}

export function normalizeExternalMemoryResults(
  value: unknown,
  defaults: {
    provider?: string;
    providerName?: string;
    startScore?: number;
  } = {},
): ExternalMemoryResult[] {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.results)
      ? value.results
      : [];
  return rows
    .map((row, index) => {
      if (!isRecord(row)) return null;
      const provider =
        safeString(row.provider || "").trim() ||
        safeString(defaults.provider || "").trim() ||
        "external";
      const providerName =
        safeString(defaults.providerName || "").trim() || provider;
      const id =
        safeString(
          row.id || row.externalId || row.reference || row.url || "",
        ).trim() || `${provider}:${index + 1}`;
      const name =
        safeString(
          row.name || row.summary || row.description || row.preview || "",
        ).trim() || `${providerName} memory`;
      const scoreValue = Number(row.score);
      const score = Number.isFinite(scoreValue)
        ? scoreValue
        : Math.max(1, Number(defaults.startScore || rows.length) - index);
      const messages = Array.isArray(row.messages)
        ? row.messages
            .map((message) => normalizeExternalMessage(message))
            .filter((message): message is NonNullable<typeof message> =>
              Boolean(message),
            )
        : undefined;
      return {
        ...row,
        sourceType: "external" as const,
        provider,
        id,
        name,
        score,
        messages,
      };
    })
    .filter(Boolean) as ExternalMemoryResult[];
}
