import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const requireFromHere = createRequire(import.meta.url);

function readJson(filePath: string) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function moduleRootFromHere() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
}

function resolveJitiStaticPath() {
  try {
    return path.join(
      path.dirname(requireFromHere.resolve("jiti/package.json")),
      "lib",
      "jiti-static.mjs",
    );
  } catch {
    return path.join(
      moduleRootFromHere(),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "node_modules",
      "jiti",
      "lib",
      "jiti-static.mjs",
    );
  }
}

function resolveJitiAliases() {
  const pkg = readJson(path.join(moduleRootFromHere(), "package.json"));
  const names = Object.keys({
    ...(pkg?.dependencies || {}),
    ...(pkg?.devDependencies || {}),
  });
  return Object.fromEntries(
    names.flatMap((name) => {
      try {
        return [[name, requireFromHere.resolve(name)]];
      } catch {
        return [];
      }
    }),
  );
}

export async function importRuntimeModule(modulePath: string) {
  if (!modulePath.endsWith(".ts")) {
    return await import(pathToFileURL(modulePath).href);
  }
  const { createJiti } = await import(
    pathToFileURL(resolveJitiStaticPath()).href
  );
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: resolveJitiAliases(),
  });
  return await jiti.import(modulePath, { default: true });
}
