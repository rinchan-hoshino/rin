import {
  latinTokens,
  normalizeNeedle,
  normalizeStringList,
  safeString,
  trimText,
  uniqueStrings,
} from "../../text-utils.js";

export {
  latinTokens,
  normalizeNeedle,
  normalizeStringList,
  safeString,
  trimText,
  uniqueStrings,
};
export { nowIso } from "../../time-utils.js";

export function normalizeList(value: unknown): string[] {
  if (Array.isArray(value)) return normalizeStringList(value);
  return normalizeStringList(safeString(value).split(","));
}

export function slugify(input: string, fallback = "memory"): string {
  const base = safeString(input).trim().toLowerCase();
  const slug = base
    .normalize("NFKD")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

export function cjkBigrams(value: string): string[] {
  const raw = safeString(value).replace(/\s+/g, "");
  const chars = [...raw].filter((char) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char),
  );
  const out: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1)
    out.push(`${chars[index]}${chars[index + 1]}`);
  return uniqueStrings(out);
}

export function conceptTokens(value: string): string[] {
  return uniqueStrings([...latinTokens(value), ...cjkBigrams(value)]);
}
