// Centralized access to Pi implementation details that Rin still needs while
// keeping Pi as an npm dependency. Prefer public Pi exports when available;
// code outside src/core/pi should not import node_modules/@earendil-works/
// pi-coding-agent/dist directly.

import { basename } from "node:path";

import { builtInExtensions } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/index.js";
import { loadExtensionFromFactory } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { resolveToCwd } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js";

export async function getPiBuiltInExtensions() {
  return builtInExtensions;
}
export {
  handleConfigCommand as handlePiConfigCommand,
  handlePackageCommand as handlePiPackageCommand,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/package-manager-cli.js";
export {
  parseArgs as parsePiCliArgs,
  printHelp as printPiCliHelp,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js";
import { str } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/render-utils.js";

export { initTheme } from "@earendil-works/pi-coding-agent";
export { APP_NAME } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/config.js";

export async function loadPiExtensionFromFactory(
  factory: any,
  cwd: string,
  eventBus: any,
  runtime: any,
  extensionPath: string,
) {
  return await loadExtensionFromFactory(
    factory,
    cwd,
    eventBus,
    runtime,
    extensionPath,
  );
}
export type { BuiltinSlashCommand as PiBuiltinSlashCommand } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js";
export { BUILTIN_SLASH_COMMANDS as PI_BUILTIN_SLASH_COMMANDS } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js";
export { formatKeyText } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/keybinding-hints.js";
export {
  onThemeChange,
  stopThemeWatcher,
  theme,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
export {
  ensureTool,
  getToolPath,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js";

export function isPiCompactSkillReadCall(args: unknown, cwd: string) {
  const input = args && typeof args === "object" ? (args as any) : {};
  const rawPath = str(input.file_path ?? input.path);
  if (!rawPath) return false;
  return (
    basename(resolveToCwd(rawPath, String(cwd || process.cwd()))) === "SKILL.md"
  );
}

export type PiManagedTool = "fd" | "rg";
export type PiEnsureTool = (
  tool: PiManagedTool,
  silent?: boolean,
) => Promise<string | undefined>;

export function getPiToolsManagerModuleUrl() {
  return new URL(
    "../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js",
    import.meta.url,
  ).href;
}

export async function loadPiToolsManagerModule(
  moduleUrl = getPiToolsManagerModuleUrl(),
): Promise<{
  ensureTool?: PiEnsureTool;
  getToolPath?: (name: string) => string;
}> {
  return (await import(moduleUrl)) as {
    ensureTool?: PiEnsureTool;
    getToolPath?: (name: string) => string;
  };
}
