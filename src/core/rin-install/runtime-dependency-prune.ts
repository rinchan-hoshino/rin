import fs from "node:fs";
import path from "node:path";

function readPackageIdentity(packageRoot: string) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
    );
    const name = String(parsed?.name || "").trim();
    const version = String(parsed?.version || "").trim();
    return name && version ? { name, version } : null;
  } catch {
    return null;
  }
}

function packagePathForName(nodeModules: string, name: string) {
  return path.join(nodeModules, ...name.split("/"));
}

function listPackageDirs(nodeModules: string) {
  const packages: Array<{ name: string; packageRoot: string }> = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(nodeModules, { withFileTypes: true });
  } catch {
    return packages;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const entryPath = path.join(nodeModules, entry.name);
    if (entry.name.startsWith("@")) {
      let scopedEntries: fs.Dirent[] = [];
      try {
        scopedEntries = fs.readdirSync(entryPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory()) continue;
        const name = `${entry.name}/${scopedEntry.name}`;
        packages.push({
          name,
          packageRoot: path.join(entryPath, scopedEntry.name),
        });
      }
    } else {
      packages.push({ name: entry.name, packageRoot: entryPath });
    }
  }
  return packages;
}

function isSymbolicLink(filePath: string) {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

export function pruneDuplicatePiCodingAgentDependencies(sourceRoot: string) {
  const rootNodeModules = path.join(sourceRoot, "node_modules");
  const piNodeModules = path.join(
    rootNodeModules,
    "@earendil-works",
    "pi-coding-agent",
    "node_modules",
  );
  const removed: string[] = [];
  if (isSymbolicLink(rootNodeModules) || isSymbolicLink(piNodeModules)) {
    return { removed };
  }
  for (const nestedPackage of listPackageDirs(piNodeModules)) {
    const nestedIdentity = readPackageIdentity(nestedPackage.packageRoot);
    if (!nestedIdentity) continue;
    const rootPackageRoot = packagePathForName(
      rootNodeModules,
      nestedIdentity.name,
    );
    if (
      path.resolve(rootPackageRoot) === path.resolve(nestedPackage.packageRoot)
    ) {
      continue;
    }
    const rootIdentity = readPackageIdentity(rootPackageRoot);
    if (
      !rootIdentity ||
      rootIdentity.name !== nestedIdentity.name ||
      rootIdentity.version !== nestedIdentity.version
    ) {
      continue;
    }
    fs.rmSync(nestedPackage.packageRoot, { recursive: true, force: true });
    removed.push(nestedIdentity.name);
    const scopeRoot = path.dirname(nestedPackage.packageRoot);
    if (path.basename(scopeRoot).startsWith("@")) {
      try {
        if (fs.readdirSync(scopeRoot).length === 0) fs.rmdirSync(scopeRoot);
      } catch {}
    }
  }
  return { removed };
}

export function appendDependencyPruneLog(
  logFile: string,
  result: { removed: string[] },
) {
  if (!result.removed.length) return;
  fs.appendFileSync(
    logFile,
    `rin: pruned duplicate @earendil-works/pi-coding-agent dependencies (${result.removed.length}): ${result.removed.join(", ")}\n`,
    "utf8",
  );
}
