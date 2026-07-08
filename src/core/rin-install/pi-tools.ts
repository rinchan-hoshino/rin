import {
  getPiToolsManagerModuleUrl,
  loadPiToolsManagerModule,
  type PiEnsureTool,
  type PiManagedTool,
} from "../pi/private-api.js";
import { isSameSystemUser } from "./users.js";

const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export type PreparePiManagedToolsOptions = {
  currentUser: string;
  targetUser: string;
  targetHome: string;
  installDir: string;
  targetNodePath?: string;
};

type EnsureTool = PiEnsureTool;

type PreparePiManagedToolsResult = {
  fd?: string;
  rg?: string;
  warnings: string[];
};

type PreparePiManagedToolsDeps = {
  ensureTool?: EnsureTool;
  runCommandAsUser?: (
    targetUser: string,
    command: string,
    args: string[],
    extraEnv?: Record<string, string>,
  ) => void;
  nodePath?: string;
  toolsManagerModuleUrl?: string;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string) => void;
};

function withTemporaryEnv<T>(
  env: NodeJS.ProcessEnv,
  values: Record<string, string>,
  operation: () => Promise<T>,
) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, env[key]);
    env[key] = value;
  }
  return operation().finally(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  });
}

async function importPiEnsureTool(
  toolsManagerModuleUrl = getPiToolsManagerModuleUrl(),
): Promise<EnsureTool> {
  const module = await loadPiToolsManagerModule(toolsManagerModuleUrl);
  if (typeof module.ensureTool !== "function") {
    throw new Error("rin_installer_fd_manager_unavailable");
  }
  return module.ensureTool;
}

function warnOptionalToolFailure(
  warnings: string[],
  warn: ((message: string) => void) | undefined,
  message: string,
) {
  warnings.push(message);
  warn?.(message);
}

export async function preparePiManagedToolsForInstall(
  options: PreparePiManagedToolsOptions,
  deps: PreparePiManagedToolsDeps = {},
): Promise<PreparePiManagedToolsResult> {
  const currentUser = String(options.currentUser || "").trim();
  const targetUser = String(options.targetUser || "").trim() || currentUser;
  const installDir = String(options.installDir || "").trim();
  if (!installDir) throw new Error("rin_installer_fd_install_dir_missing");

  const warnings: string[] = [];
  const envValues = {
    HOME: String(options.targetHome || "").trim(),
    RIN_DIR: installDir,
    [PI_AGENT_DIR_ENV]: installDir,
  };

  if (
    !targetUser ||
    isSameSystemUser(targetUser, currentUser) ||
    process.platform === "win32"
  ) {
    const env = deps.env ?? process.env;
    let ensureTool: EnsureTool;
    try {
      ensureTool = deps.ensureTool ?? (await importPiEnsureTool());
    } catch (error) {
      warnOptionalToolFailure(
        warnings,
        deps.warn,
        `Rin installer skipped fd/rg preparation: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { warnings };
    }
    const toolPaths = await withTemporaryEnv(env, envValues, async () => {
      const fdPath = await ensureTool("fd", false).catch((error) => {
        warnOptionalToolFailure(
          warnings,
          deps.warn,
          `Rin installer could not prepare fd: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      });
      const rgPath = await ensureTool("rg", false).catch((error) => {
        warnOptionalToolFailure(
          warnings,
          deps.warn,
          `Rin installer could not prepare rg: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      });
      return { fd: fdPath, rg: rgPath };
    });
    if (!toolPaths.fd) {
      warnOptionalToolFailure(
        warnings,
        deps.warn,
        "Rin installer could not prepare fd; file autocomplete may be slower until fd/fdfind is available.",
      );
    }
    if (!toolPaths.rg) {
      warnOptionalToolFailure(
        warnings,
        deps.warn,
        "Rin installer could not prepare rg; grep/search commands may be unavailable until ripgrep is available.",
      );
    }
    return { ...toolPaths, warnings };
  }

  const toolsManagerModuleUrl =
    deps.toolsManagerModuleUrl ?? getPiToolsManagerModuleUrl();
  const script = [
    `const moduleUrl = ${JSON.stringify(toolsManagerModuleUrl)};`,
    "const { ensureTool } = await import(moduleUrl);",
    "const fdPath = await ensureTool('fd', false);",
    "const rgPath = await ensureTool('rg', false);",
    "if (!fdPath) console.warn('Rin installer could not prepare fd; file autocomplete may be slower until fd/fdfind is available.');",
    "if (!rgPath) console.warn('Rin installer could not prepare rg; grep/search commands may be unavailable until ripgrep is available.');",
  ].join("\n");
  const runCommandAsUser = deps.runCommandAsUser;
  if (!runCommandAsUser) {
    warnOptionalToolFailure(
      warnings,
      deps.warn,
      "Rin installer skipped fd/rg preparation because target-user command execution is unavailable.",
    );
    return { warnings };
  }
  const nodePath = String(options.targetNodePath || deps.nodePath || "").trim();
  if (!nodePath) {
    warnOptionalToolFailure(
      warnings,
      deps.warn,
      "Rin installer skipped fd/rg preparation because the target Node runtime is unavailable.",
    );
    return { warnings };
  }
  try {
    runCommandAsUser(
      targetUser,
      nodePath,
      ["--input-type=module", "-e", script],
      envValues,
    );
  } catch (error) {
    warnOptionalToolFailure(
      warnings,
      deps.warn,
      `Rin installer skipped fd/rg preparation for ${targetUser}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { warnings };
}
