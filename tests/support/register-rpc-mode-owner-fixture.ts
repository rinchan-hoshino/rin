import "./require-test-sandbox.ts";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const target = "dist/core/rin-daemon/rpc-mode.js";
const modules = {
  "dist/core/pi/session-host.js": [
    "emitPiSessionEvent",
    "refreshPiSessionToolRegistry",
    "reloadPiSessionWithActiveTools",
    "resumePiSessionTurn",
  ],
  "dist/core/session/factory.js": [
    "listBoundSessionPage",
    "listBoundSessions",
    "renameBoundSession",
  ],
  "dist/core/rin-daemon/worker-helpers.js": [
    "abortCurrentSessionOperation",
    "getCommandArgumentCompletions",
    "getOAuthState",
    "getResourceDiagnostics",
    "getSessionState",
    "getSlashCommands",
    "runBuiltinCommand",
    "writeJsonLine",
  ],
} as const;

const replacements = Object.fromEntries(
  Object.entries(modules).map(([relativePath, exports]) => {
    const actualUrl = `${pathToFileURL(path.join(rootDir, relativePath)).href}?rpc-mode-owner-actual`;
    const source = `
      import * as actual from ${JSON.stringify(actualUrl)};
      const owner = globalThis.__rpcModeOwner;
      ${exports
        .map((name) =>
          name === "writeJsonLine"
            ? `export const writeJsonLine = (...args) => { owner.outputs.push(args[0]); return owner.overrides.writeJsonLine ? owner.overrides.writeJsonLine(...args) : actual.writeJsonLine(...args); };`
            : `export const ${name} = (...args) => owner.overrides.${name} ? owner.overrides.${name}(...args) : actual.${name}(...args);`,
        )
        .join("\n")}
    `;
    return [relativePath, `data:text/javascript,${encodeURIComponent(source)}`];
  }),
);

const hook = `
const target = ${JSON.stringify(target)};
const ownerTargets = [
  target,
  "dist/core/rin-daemon/rpc-auth-command-handler.js",
  "dist/core/rin-daemon/rpc-resource-command-handler.js",
  "dist/core/rin-daemon/rpc-session-command-handler.js",
  "dist/core/rin-daemon/rpc-turn-command-handler.js",
];
const replacements = ${JSON.stringify(replacements)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (!ownerTargets.some((suffix) => context.parentURL?.endsWith(suffix))) return resolved;
  for (const [suffix, replacement] of Object.entries(replacements)) {
    if (resolved.url.endsWith(suffix)) return { url: replacement, shortCircuit: true };
  }
  return resolved;
}
export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  if (!url.endsWith(target)) return loaded;
  return {
    ...loaded,
    source: String(loaded.source) + "\\nexport { createExtensionUiResponseParser as __rinOwnerCreateExtensionUiResponseParser };\\nexport { stableJson as __rinOwnerStableJson, rpcRequestTag as __rinOwnerRpcRequestTag } from './rpc-turn-command-handler.js';\\nexport { getSessionEntries as __rinOwnerGetSessionEntries, getSessionEntriesSince as __rinOwnerGetSessionEntriesSince, getSessionLeafId as __rinOwnerGetSessionLeafId, getSessionTree as __rinOwnerGetSessionTree, clampSessionThinkingLevel as __rinOwnerClampSessionThinkingLevel } from './rpc-session-command-handler.js';\\nexport { combinedLoginPromptSignal as __rinOwnerCombinedLoginPromptSignal, logoutSessionProvider as __rinOwnerLogoutSessionProvider } from './rpc-auth-command-handler.js';\\nexport { isWorkerLocalSessionReplacementCommand as __rinOwnerIsWorkerLocalSessionReplacementCommand } from './rpc-resource-command-handler.js';\\n",
    shortCircuit: true,
  };
}
`;

register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

(globalThis as any).__rpcModeOwner ||= { outputs: [], overrides: {} };
