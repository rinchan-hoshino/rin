import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const requireFromHere = createRequire(import.meta.url);

function readJson(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function resolveImportAlias(packageName: string) {
  try {
    const resolved = import.meta.resolve(packageName);
    return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
  } catch {
    return requireFromHere.resolve(packageName);
  }
}

type AliasOptions = {
  includeDevDependencies?: boolean;
  includeOptionalDependencies?: boolean;
};

export function resolveRuntimePackageAliases(options: AliasOptions = {}) {
  const pkg = readJson(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "package.json",
    ),
  );
  const names = new Set([
    ...Object.keys(pkg?.dependencies || {}),
    ...(options.includeDevDependencies
      ? Object.keys(pkg?.devDependencies || {})
      : []),
    ...(options.includeOptionalDependencies
      ? Object.keys(pkg?.optionalDependencies || {})
      : []),
  ]);
  const aliases: Record<string, string> = {};
  for (const name of names) {
    try {
      aliases[name] = resolveImportAlias(name);
    } catch {
      // Extensions may carry optional dependencies that are absent at runtime.
    }
  }
  return aliases;
}
