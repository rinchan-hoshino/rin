import { safeString } from "../text-utils.js";

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatLocalDateOnly(date = new Date()) {
  const year = `${date.getFullYear()}`;
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeCanonicalDateOnly(value: string) {
  const match = value.match(DATE_ONLY_RE);
  if (!match) return "";
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return "";
  }
  return `${yearText}-${monthText}-${dayText}`;
}

function hasLeadingDateOnlySuffix(suffix: string): boolean {
  return !suffix || /^[Tt]\d/.test(suffix) || /^\s+\d/.test(suffix);
}

function normalizeTextDateOnly(value: unknown): string {
  const text = safeString(value).trim();
  if (!text) return "";
  const normalized = normalizeCanonicalDateOnly(text.slice(0, 10));
  return normalized && hasLeadingDateOnlySuffix(text.slice(10))
    ? normalized
    : "";
}

function normalizeDateValue(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : formatLocalDateOnly(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatLocalDateOnly(new Date(value));
  }
  return "";
}

export function localDateUtcBounds(value: unknown) {
  const date = normalizeLocalDateOnly(value);
  if (!date) return null;
  const [year, month, day] = date.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const end = new Date(year, month - 1, day + 1);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start: start.toISOString(), end: end.toISOString() };
}

export function normalizeLocalDateOnly(
  value: unknown,
  fallbackDate?: Date | null,
) {
  return (
    normalizeTextDateOnly(value) ||
    normalizeDateValue(value) ||
    (fallbackDate ? formatLocalDateOnly(fallbackDate) : "")
  );
}
