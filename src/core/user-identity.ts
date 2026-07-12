export function normalizeUserName(value: unknown) {
  return String(value || "").trim();
}

function normalizeComparableUserName(
  value: unknown,
  platform: NodeJS.Platform = process.platform,
) {
  const normalized = normalizeUserName(value);
  if (platform !== "win32") return normalized;
  return normalized.replace(/\//g, "\\").toLowerCase();
}

function windowsAccountParts(value: string) {
  const parts = value.split("\\").filter(Boolean);
  return {
    domain: parts.length > 1 ? parts.slice(0, -1).join("\\") : "",
    name: parts[parts.length - 1] || value,
  };
}

export function isSameSystemUser(
  a: unknown,
  b: unknown,
  platform: NodeJS.Platform = process.platform,
) {
  const left = normalizeComparableUserName(a, platform);
  const right = normalizeComparableUserName(b, platform);
  if (!left || !right) return false;
  if (left === right) return true;
  if (platform !== "win32") return false;
  const leftParts = windowsAccountParts(left);
  const rightParts = windowsAccountParts(right);
  return (
    leftParts.name === rightParts.name &&
    (!leftParts.domain || !rightParts.domain)
  );
}
