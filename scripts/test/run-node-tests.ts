import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const result = spawnSync(process.execPath, process.argv.slice(2), {
  cwd: rootDir,
  env: process.env,
  encoding: "utf8",
  stdio: ["inherit", "pipe", "pipe"],
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;

let status = result.status ?? 1;
if (status === 0) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const summaryValue = (name: string) => {
    const matches = [
      ...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gm")),
    ];
    return matches.length > 0 ? Number(matches.at(-1)?.[1]) : undefined;
  };
  const tests = summaryValue("tests");
  const skipped = summaryValue("skipped");
  const todo = summaryValue("todo");
  if (tests === undefined || skipped === undefined || todo === undefined) {
    console.error("test_summary_missing");
    status = 1;
  } else if (skipped > 0 || todo > 0) {
    console.error(`test_summary_rejected:skipped=${skipped}:todo=${todo}`);
    status = 1;
  }
}

const coverageDir = process.env.NODE_V8_COVERAGE;
if (coverageDir) {
  const hostPrefix = pathToFileURL(`${rootDir}${path.sep}`).href;
  for (const name of await fs.readdir(coverageDir)) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(coverageDir, name);
    const raw = await fs.readFile(filePath, "utf8");
    const rewritten = raw.replace(
      /file:\/\/\/[^"\\]*\/rin-install-tui-e2e-[^/"\\]+\/install\/app\/releases\/[^/"\\]+\/dist\//g,
      `${hostPrefix}dist/`,
    );
    if (rewritten !== raw) await fs.writeFile(filePath, rewritten, "utf8");
  }
}

process.exitCode = status;
