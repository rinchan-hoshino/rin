import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { type InstalledReleaseInfo } from "../rin-lib/release.js";
import { shellQuote } from "../rin-lib/system.js";

export type FinalizeInstallOptions = {
  currentUser: string;
  targetUser: string;
  installDir: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  language?: string;
  setDefaultTarget?: boolean;
  chatDescription?: string;
  chatDetail?: string;
  chatConfig?: any;
  authData?: any;
  sourceRoot?: string;
  release?: InstalledReleaseInfo;
  daemonReadyTimeoutMs?: number;
};

export function writeFinalizeInstallPlanFile(
  options: FinalizeInstallOptions,
  deps: {
    tmpdir?: () => string;
    writeFileSync?: typeof fs.writeFileSync;
    chmodSync?: typeof fs.chmodSync;
    mkdtempSync?: typeof fs.mkdtempSync;
  } = {},
) {
  const tmpdir = deps.tmpdir || os.tmpdir;
  const mkdtempSync = deps.mkdtempSync || fs.mkdtempSync;
  const writeFileSync = deps.writeFileSync || fs.writeFileSync;
  const chmodSync = deps.chmodSync || fs.chmodSync;
  const planDir = mkdtempSync(path.join(tmpdir(), "rin-install-plan-"));
  const planPath = path.join(planDir, "apply-plan.json");
  writeFileSync(planPath, `${JSON.stringify(options, null, 2)}\n`, "utf8");
  chmodSync(planPath, 0o600);
  return planPath;
}

export function buildFinalizeInstallPlanCommand(
  planPath: string,
  entryPath = process.argv[1] || fileURLToPath(import.meta.url),
) {
  return [
    shellQuote(process.execPath),
    shellQuote(entryPath),
    "--apply-plan-file",
    shellQuote(planPath),
  ].join(" ");
}

export async function runFinalizeInstallPlanInChild(
  options: FinalizeInstallOptions,
  message: string,
  deps: {
    spawnImpl?: typeof spawn;
    writeStatus?: (message: string) => void;
  } = {},
) {
  const resultDir = fs.mkdtempSync(path.join(os.tmpdir(), "rin-install-"));
  const planPath = path.join(resultDir, "apply-plan.json");
  const resultPath = path.join(resultDir, "result.json");
  const errorPath = path.join(resultDir, "error.txt");
  try {
    const spawnImpl = deps.spawnImpl || spawn;
    const writeStatus =
      deps.writeStatus ||
      ((status: string) => process.stderr.write(`${status}\n`));
    writeStatus(message);

    fs.writeFileSync(planPath, `${JSON.stringify(options)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const child = spawnImpl(
      process.execPath,
      [
        process.argv[1] || fileURLToPath(import.meta.url),
        "--apply-plan-file",
        planPath,
        "--apply-result-file",
        resultPath,
        "--apply-error-file",
        errorPath,
      ],
      {
        stdio: ["inherit", "inherit", "inherit"],
        env: process.env,
      },
    );

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal)
          reject(new Error(`rin_installer_child_terminated:${signal}`));
        else resolve(code ?? 1);
      });
    });

    if (exitCode !== 0) {
      let errorMessage = "rin_installer_apply_failed";
      try {
        errorMessage =
          fs.readFileSync(errorPath, "utf8").trim() || errorMessage;
      } catch {}
      throw new Error(errorMessage);
    }

    let parsed: any = null;
    try {
      parsed = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    } catch {
      throw new Error("rin_installer_apply_result_missing");
    }

    return parsed;
  } finally {
    try {
      fs.rmSync(resultDir, { recursive: true, force: true });
    } catch {}
  }
}
