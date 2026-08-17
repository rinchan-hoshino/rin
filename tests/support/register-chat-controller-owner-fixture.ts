import "./require-test-sandbox.ts";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const target = "dist/core/chat/controller.js";
const actualBootUrl = `${
  pathToFileURL(path.join(rootDir, "dist/core/chat/boot.js")).href
}?chat-controller-owner-actual`;
const replacement = `
  import {
    applyPostDelivery as actualApplyPostDelivery,
    drainChatOutbox as actualDrainChatOutbox,
  } from ${JSON.stringify(actualBootUrl)};
  export const applyPostDelivery = (...args) => actualApplyPostDelivery(...args);
  export const drainChatOutbox = (...args) => {
    const override = globalThis.__chatControllerOwnerFixture.drainChatOutbox;
    return override ? override(...args) : actualDrainChatOutbox(...args);
  };
`;
const replacementUrl = `data:text/javascript,${encodeURIComponent(replacement)}`;
const hook = `
const target = ${JSON.stringify(target)};
const replacementUrl = ${JSON.stringify(replacementUrl)};
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (
    context.parentURL?.endsWith(target) &&
    resolved.url.endsWith("dist/core/chat/boot.js")
  ) {
    return { url: replacementUrl, shortCircuit: true };
  }
  return resolved;
}
`;

register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

(globalThis as any).__chatControllerOwnerFixture ||= {
  drainChatOutbox: undefined,
};
