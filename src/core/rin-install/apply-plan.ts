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
  setDefaultTarget?: boolean;
  authData?: any;
  sourceRoot?: string;
  release?: InstalledReleaseInfo;
  daemonReadyTimeoutMs?: number;
  coreUpdate?: boolean;
  reinstallCurrentRelease?: boolean;
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

export function cleanupConsumedFinalizeInstallPlan(
  planPath: string,
  deps: {
    tmpdir?: typeof os.tmpdir;
    realpathSync?: typeof fs.realpathSync;
    lstatSync?: typeof fs.lstatSync;
    rmSync?: typeof fs.rmSync;
  } = {},
) {
  const tmpdir = deps.tmpdir || os.tmpdir;
  const realpathSync = deps.realpathSync || fs.realpathSync;
  const lstatSync = deps.lstatSync || fs.lstatSync;
  const rmSync = deps.rmSync || fs.rmSync;
  const resolvedPlan = path.resolve(planPath);
  const planDir = path.dirname(resolvedPlan);
  try {
    const planDirStat = lstatSync(planDir);
    if (
      path.basename(resolvedPlan) !== "apply-plan.json" ||
      !path.basename(planDir).startsWith("rin-install-plan-") ||
      planDirStat.isSymbolicLink() ||
      !planDirStat.isDirectory() ||
      realpathSync(path.dirname(planDir)) !== realpathSync(tmpdir())
    ) {
      return false;
    }
    rmSync(planDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
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

const FORWARDED_CHILD_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

function signalExitCode(signal: NodeJS.Signals) {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGHUP") return 129;
  return 1;
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
    let forwardedSignal: NodeJS.Signals | null = null;
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of FORWARDED_CHILD_SIGNALS) {
      const handler = () => {
        forwardedSignal = signal;
        if (!child.killed) child.kill(signal);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        for (const [registeredSignal, handler] of handlers) {
          process.off(registeredSignal, handler);
        }
        if (forwardedSignal) process.exit(signalExitCode(forwardedSignal));
        if (signal) process.exit(signalExitCode(signal));
        else resolve(code ?? 1);
      });
    });

    if (exitCode !== 0) {
      let errorMessage = "";
      try {
        errorMessage = fs.readFileSync(errorPath, "utf8").trim();
      } catch {}
      if (errorMessage) throw new Error(errorMessage);
      const handoffError = new Error("rin_installer_apply_handoff_missing");
      (handoffError as any).suppressUserFacingPrint = true;
      throw handoffError;
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
