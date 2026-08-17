import "./require-test-sandbox.ts";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export function importBuiltModule<T = Record<string, unknown>>(
  relativePath: string,
): Promise<T> {
  return import(
    pathToFileURL(path.join(rootDir, relativePath)).href
  ) as Promise<T>;
}
