import { register } from "node:module";

const replacements = {
  "dist/core/rin-lib/loader.js": `
    export async function loadRinSessionManagerModule() {
      return {
        SessionManager: {
          open(sessionFile, sessionDir) {
            globalThis.__rinMaintainerOwnerEvents.push(["open", sessionFile, sessionDir]);
            return {
              getCwd() {
                return globalThis.__rinMaintainerOwnerCwd;
              },
            };
          },
        },
      };
    }
  `,
  "dist/core/session/factory.js": `
    export async function openBoundSession(options) {
      globalThis.__rinMaintainerOwnerEvents.push(["bind", options]);
      return {
        session: {
          async prompt(prompt, promptOptions) {
            globalThis.__rinMaintainerOwnerEvents.push(["prompt", prompt, promptOptions]);
            await globalThis.__rinMaintainerOwnerMutation?.(prompt, promptOptions);
          },
          agent: {
            async waitForIdle() {
              globalThis.__rinMaintainerOwnerEvents.push(["idle"]);
            },
          },
          getLastAssistantText() {
            return globalThis.__rinMaintainerOwnerFinalText;
          },
          async abort() {
            globalThis.__rinMaintainerOwnerEvents.push(["abort"]);
            if (globalThis.__rinMaintainerOwnerAbortFails) throw new Error("owner_abort_failed");
          },
        },
        runtime: {
          async dispose() {
            globalThis.__rinMaintainerOwnerEvents.push(["dispose"]);
            if (globalThis.__rinMaintainerOwnerDisposeFails) throw new Error("owner_dispose_failed");
          },
        },
      };
    }
  `,
  "dist/core/session/fork.js": `
    export function forkSessionManagerCompat(...args) {
      globalThis.__rinMaintainerOwnerEvents.push(["fork", args]);
      return { kind: "owner-fork", args };
    }
  `,
  "dist/core/session/metadata.js": `
    export function readSessionMetadata(value = {}) {
      const manager = value.sessionManager;
      return {
        sessionId: value.sessionId || manager?.getSessionId?.() || "",
        sessionFile: value.sessionFile || manager?.getSessionFile?.() || "",
        leafId: value.leafId || manager?.getLeafId?.() || "",
      };
    }
  `,
};

const replacementUrls = Object.fromEntries(
  Object.entries(replacements).map(([target, source]) => [
    target,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const hookSource = `
const replacements = ${JSON.stringify(replacementUrls)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  for (const [target, replacementUrl] of Object.entries(replacements)) {
    if (resolved.url.endsWith(target)) {
      return { url: replacementUrl, shortCircuit: true };
    }
  }
  return resolved;
}
`;
register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
