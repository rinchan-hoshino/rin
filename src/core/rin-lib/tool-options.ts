export type RinToolStartupOptions = {
  tools?: string[];
  excludeTools?: string[];
  noTools?: "all" | "builtin";
};

const DEFAULT_PI_ACTIVE_BUILTIN_TOOL_NAMES = new Set([
  "read",
  "bash",
  "edit",
  "write",
]);

function hasOwn(value: object | undefined, key: keyof RinToolStartupOptions) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

export function parseRinToolNameList(value: unknown) {
  return String(value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function uniqueToolNames(values: unknown) {
  const list = Array.isArray(values)
    ? values.flatMap((value) => parseRinToolNameList(value))
    : parseRinToolNameList(values);
  return [...new Set(list)];
}

export function normalizeRinToolStartupOptions(
  options: Partial<RinToolStartupOptions> | undefined,
): RinToolStartupOptions {
  const normalized: RinToolStartupOptions = {};
  if (hasOwn(options, "tools") && options?.tools !== undefined) {
    normalized.tools = uniqueToolNames(options.tools);
  }
  if (hasOwn(options, "excludeTools") && options?.excludeTools !== undefined) {
    normalized.excludeTools = uniqueToolNames(options.excludeTools);
  }
  if (options?.noTools === "all" || options?.noTools === "builtin") {
    normalized.noTools = options.noTools;
  }
  return normalized;
}

export function hasRinToolStartupOptions(
  options: Partial<RinToolStartupOptions> | undefined,
) {
  const normalized = normalizeRinToolStartupOptions(options);
  return (
    hasOwn(normalized, "tools") ||
    hasOwn(normalized, "excludeTools") ||
    normalized.noTools !== undefined
  );
}

export function serializeRinToolStartupOptions(
  options: Partial<RinToolStartupOptions> | undefined,
) {
  const normalized = normalizeRinToolStartupOptions(options);
  return hasRinToolStartupOptions(normalized) ? normalized : {};
}

export function resolveRinActiveToolNames(
  currentToolNames: unknown,
  options: Partial<RinToolStartupOptions> | undefined,
) {
  const normalized = normalizeRinToolStartupOptions(options);
  const excluded = new Set(normalized.excludeTools ?? []);
  const filterExcluded = (toolNames: string[]) =>
    toolNames.filter((name) => !excluded.has(name));

  if (hasOwn(normalized, "tools")) {
    return filterExcluded(normalized.tools ?? []);
  }

  let active = uniqueToolNames(currentToolNames);
  if (normalized.noTools === "all") {
    active = [];
  } else if (normalized.noTools === "builtin") {
    active = active.filter(
      (name) => !DEFAULT_PI_ACTIVE_BUILTIN_TOOL_NAMES.has(name),
    );
  }
  return filterExcluded(active);
}
