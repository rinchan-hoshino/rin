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
    "canResumePiSessionRetry",
    "emitPiSessionEvent",
    "refreshPiSessionToolRegistry",
    "resumePiSessionRetry",
    "resumePiSessionTurn",
  ],
  "dist/core/session/factory.js": [
    "listBoundSessionPage",
    "listBoundSessions",
    "renameBoundSession",
  ],
  "dist/core/rin-daemon/worker-helpers.js": [
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
const replacements = ${JSON.stringify(replacements)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (!context.parentURL?.endsWith(target)) return resolved;
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
    source: String(loaded.source) + "\\nexport { createExtensionUiResponseParser as __rinOwnerCreateExtensionUiResponseParser, latestCompactionTokensBefore as __rinOwnerLatestCompactionTokensBefore, withCompactionEventMetadata as __rinOwnerWithCompactionEventMetadata, stableJson as __rinOwnerStableJson, rpcRequestTag as __rinOwnerRpcRequestTag, getSessionEntries as __rinOwnerGetSessionEntries, getSessionEntriesSince as __rinOwnerGetSessionEntriesSince, getSessionLeafId as __rinOwnerGetSessionLeafId, getSessionTree as __rinOwnerGetSessionTree, clampSessionThinkingLevel as __rinOwnerClampSessionThinkingLevel, combinedLoginPromptSignal as __rinOwnerCombinedLoginPromptSignal, isWorkerLocalSessionReplacementCommand as __rinOwnerIsWorkerLocalSessionReplacementCommand, logoutSessionProvider as __rinOwnerLogoutSessionProvider };\\n",
    shortCircuit: true,
  };
}
`;

register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

(globalThis as any).__rpcModeOwner ||= { outputs: [], overrides: {} };
