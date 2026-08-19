import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function ensurePrivateDir(dir: string) {
  ensureDir(dir);
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
}

export function stringifyJson(value: unknown, trailingNewline = true) {
  const text = JSON.stringify(value, null, 2);
  return trailingNewline ? `${text}\n` : text;
}

export function stringifyJsonLine(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

export function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function readJsonFileOrDefault<T>(filePath: string, fallback: T): T {
  try {
    return readJsonFile<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return fallback;
    throw error;
  }
}

function ensureParentDir(filePath: string, privateDir = false) {
  const dir = path.dirname(filePath);
  (privateDir ? ensurePrivateDir : ensureDir)(dir);
}

function writeJsonText(filePath: string, text: string, append = false) {
  ensureParentDir(filePath);
  if (append) {
    fs.appendFileSync(filePath, text, "utf8");
    return;
  }
  fs.writeFileSync(filePath, text, "utf8");
}

export function writeJsonFile(filePath: string, value: unknown) {
  writeJsonText(filePath, stringifyJson(value));
}

export function appendJsonLineSync(filePath: string, value: unknown) {
  writeJsonText(filePath, stringifyJsonLine(value), true);
}

export async function appendJsonLine(filePath: string, value: unknown) {
  ensureParentDir(filePath);
  await fs.promises.appendFile(filePath, stringifyJsonLine(value), "utf8");
}

export function preferredTempRootCandidates() {
  return Array.from(
    new Set(
      [process.env.TMPDIR, os.tmpdir()]
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .map((value) => path.resolve(value)),
    ),
  );
}

export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  mode = 0o600,
  privateDir = false,
) {
  ensureParentDir(filePath, privateDir);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, stringifyJson(value), { mode });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, mode);
  } catch {}
}

export function listJsonFiles(dir: string) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [] as string[];
  }
}

function moveFile(sourcePath: string, targetPath: string) {
  try {
    fs.renameSync(sourcePath, targetPath);
    return;
  } catch (error: any) {
    if (error?.code !== "EXDEV") throw error;
  }

  fs.copyFileSync(sourcePath, targetPath);
  try {
    fs.unlinkSync(sourcePath);
  } catch (error) {
    removeFileIfExists(targetPath);
    throw error;
  }
}

function moveFileIntoDir(
  filePath: string,
  dir: string,
  fileName = path.basename(filePath),
) {
  ensureDir(dir);
  const targetPath = path.join(dir, fileName);
  moveFile(filePath, targetPath);
  return targetPath;
}

export function claimFileToDir(filePath: string, dir: string) {
  try {
    return moveFileIntoDir(filePath, dir);
  } catch {
    return "";
  }
}

export function moveFileToDir(
  filePath: string,
  dir: string,
  fileName = path.basename(filePath),
) {
  return moveFileIntoDir(filePath, dir, fileName);
}

export function removeFileIfExists(filePath: string) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {}
}
