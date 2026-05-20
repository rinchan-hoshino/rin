import crypto from "node:crypto";

import { safeString } from "../text-utils.js";

export {
  latinTokens,
  normalizeNeedle,
  trimText,
  uniqueStrings,
} from "../text-utils.js";
export { safeString };

export function sha(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function parseTimestampMs(value: unknown): number {
  const raw = safeString(value).trim();
  if (!raw) return 0;

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    const absolute = Math.abs(numeric);
    if (absolute >= 1_000_000_000_000) return Math.trunc(numeric);
    if (absolute >= 1_000_000_000) return Math.trunc(numeric * 1000);
    return Math.trunc(numeric);
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}
