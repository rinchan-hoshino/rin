import crypto from "node:crypto";

export {
  latinTokens,
  normalizeNeedle,
  safeString,
  trimText,
  uniqueStrings,
} from "../text-utils.js";

export function sha(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
