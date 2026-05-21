import fs from "node:fs";
import path from "node:path";

function text(value: unknown) {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function readJson(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function resolveManifestEntry(root: string, entry: unknown) {
  const value = text(entry).trim();
  if (
    !value ||
    value.startsWith("!") ||
    value.startsWith("+") ||
    value.startsWith("-")
  ) {
    return "";
  }
  return path.resolve(root, value);
}

function packageOwnsExtensionEntry(
  root: string,
  pkg: any,
  extensionPath: string,
) {
  const entries = Array.isArray(pkg?.pi?.extensions) ? pkg.pi.extensions : [];
  const resolvedExtensionPath = path.resolve(extensionPath);
  return entries
    .map((entry) => resolveManifestEntry(root, entry))
    .some((entry) => entry && path.resolve(entry) === resolvedExtensionPath);
}

function findOwningPackage(extensionPath: string) {
  let dir = path.dirname(extensionPath);
  while (true) {
    const packageJsonPath = path.join(dir, "package.json");
    const pkg = fs.existsSync(packageJsonPath)
      ? readJson(packageJsonPath)
      : undefined;
    if (
      pkg &&
      typeof pkg === "object" &&
      packageOwnsExtensionEntry(dir, pkg, extensionPath)
    ) {
      return {
        packageName: typeof pkg.name === "string" ? pkg.name : undefined,
        packageRoot: dir,
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function enrichResolvedExtensionResources<
  T extends { path: string; metadata?: Record<string, any> },
>(resources: T[]): T[] {
  return resources.map((resource) => {
    const owner = findOwningPackage(resource.path);
    if (!owner) return resource;
    return {
      ...resource,
      metadata: {
        ...(resource.metadata || {}),
        ...(owner.packageName ? { packageName: owner.packageName } : {}),
        packageRoot: owner.packageRoot,
        baseDir: owner.packageRoot,
      },
    };
  });
}
