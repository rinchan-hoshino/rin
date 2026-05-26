import { safeString } from "../text-utils.js";

export type RinFrontendIdentity = {
  kind: string;
  key?: string;
};

export const TUI_FRONTEND_IDENTITY: RinFrontendIdentity = { kind: "tui" };

export function normalizeFrontendIdentity(
  value: unknown,
): RinFrontendIdentity | undefined {
  const identity = value as any;
  const kind = safeString(identity?.kind).trim();
  if (!kind) return undefined;
  const key = safeString(identity?.key ?? identity?.id).trim();
  return key ? { kind, key } : { kind };
}

export function chatFrontendIdentity(
  chatKey: string,
): RinFrontendIdentity | undefined {
  const key = safeString(chatKey).trim();
  return key ? { kind: "chat", key } : undefined;
}

export function sourceFrontendIdentity(source: string): RinFrontendIdentity {
  return { kind: safeString(source).trim() || "frontend" };
}

export function sameFrontendIdentity(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeFrontendIdentity(left);
  const normalizedRight = normalizeFrontendIdentity(right);
  return Boolean(
    normalizedLeft &&
    normalizedRight &&
    normalizedLeft.kind === normalizedRight.kind &&
    safeString(normalizedLeft.key).trim() ===
      safeString(normalizedRight.key).trim(),
  );
}
