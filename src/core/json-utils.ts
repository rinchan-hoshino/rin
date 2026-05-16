function isObjectValue(value: unknown): value is object {
  return Boolean(value) && typeof value === "object";
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneJsonIfObject<T>(value: T): T | undefined {
  return isObjectValue(value) ? cloneJson(value) : undefined;
}

export function isJsonRecord(value: unknown): value is Record<string, any> {
  return isObjectValue(value) && !Array.isArray(value);
}

export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
