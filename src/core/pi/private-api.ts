// Centralized access to Pi implementation details that Rin still needs while
// keeping Pi as an npm dependency. Prefer public Pi exports when available;
// code outside src/core/pi should not import node_modules/@earendil-works/
// pi-coding-agent/dist directly.

import { basename } from "node:path";

import {
  estimateTokens,
  prepareCompaction,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/index.js";
import { builtInExtensions } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/extensions/index.js";
import { resolveToCwd } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/path-utils.js";

export function preparePiSessionCompaction(pathEntries: any[], settings: any) {
  return prepareCompaction(pathEntries, settings);
}

export function estimatePiMessagesTokens(messages: any[]) {
  return (Array.isArray(messages) ? messages : []).reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
}

export function withPiDefaultExtensionFactories<T>(
  options: T,
): T & { extensionFactories: unknown[] } {
  const extensionFactories = Array.isArray((options as any)?.extensionFactories)
    ? (options as any).extensionFactories
    : [];
  return {
    ...(options as any),
    extensionFactories: [...builtInExtensions, ...extensionFactories],
  };
}
export {
  handleConfigCommand as handlePiConfigCommand,
  handlePackageCommand as handlePiPackageCommand,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/package-manager-cli.js";
import { str } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/render-utils.js";

export { initTheme } from "@earendil-works/pi-coding-agent";
export { APP_NAME } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/config.js";

export type { BuiltinSlashCommand as PiBuiltinSlashCommand } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js";
export { BUILTIN_SLASH_COMMANDS as PI_BUILTIN_SLASH_COMMANDS } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/slash-commands.js";
export { formatKeyText } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/keybinding-hints.js";
export {
  onThemeChange,
  theme,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
export { getToolPath } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js";

export function isPiCompactSkillReadCall(args: unknown, cwd: string) {
  const input = args && typeof args === "object" ? (args as any) : {};
  const rawPath = str(input.file_path ?? input.path);
  if (!rawPath) return false;
  return (
    basename(resolveToCwd(rawPath, String(cwd || process.cwd()))) === "SKILL.md"
  );
}

export async function runPiInteractiveModeInit<T>(
  nativeInit: (this: unknown, ...args: any[]) => Promise<T>,
  receiver: unknown,
  args: any[] = [],
): Promise<T> {
  const previousPiOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    return await nativeInit.apply(receiver, args);
  } finally {
    if (previousPiOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousPiOffline;
  }
}
