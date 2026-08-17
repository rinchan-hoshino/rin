import "./require-test-sandbox.ts";
import { register } from "node:module";

const targets = ["dist/core/chat/platform/telegram.js"];
const ownerExports: Record<string, string> = {
  "dist/core/chat/platform/telegram.js":
    "export { renderTelegramHtmlFromNodes as __rinOwnerRenderTelegramHtmlFromNodes, isTelegramMediaNodeType as __rinOwnerIsTelegramMediaNodeType, telegramMediaMethod as __rinOwnerTelegramMediaMethod, decodeTelegramThreadId as __rinOwnerDecodeTelegramThreadId, splitTelegramChatThread as __rinOwnerSplitTelegramChatThread, telegramThreadPayload as __rinOwnerTelegramThreadPayload, isTelegramPhotoDimensionError as __rinOwnerIsTelegramPhotoDimensionError, isTelegramProviderRejection as __rinOwnerIsTelegramProviderRejection };",
};
const sources: Record<string, string> = {
  grammy: `
    export class InputFile {
      constructor(data, filename) { this.data = data; this.filename = filename; }
    }
    export class Api {
      constructor(token, options) {
        this.token = token;
        this.options = options;
        this.raw = new Proxy({}, {
          get: (_target, method) => async (...args) => {
            globalThis.__chatRuntimeIndexOwner.apiCalls.push([String(method), ...args]);
            const handler = globalThis.__chatRuntimeIndexOwner.apiHandlers[String(method)];
            if (handler) return await handler(...args);
            const payload = args[0] instanceof AbortSignal ? undefined : args[0];
            const signal = args.find((value) => value instanceof AbortSignal);
            const response = await this.options.fetch(
              "https://api.telegram.org/bot" + this.token + "/" + String(method),
              { method: "POST", body: payload == null ? undefined : JSON.stringify(payload), signal },
            );
            const body = await response.json();
            if (!body.ok) throw new Error(body.description || "telegram_fixture_failed");
            return body.result;
          },
        });
      }
    }
  `,
  undici: `
    export class Agent {
      constructor(options) { this.options = options; globalThis.__chatRuntimeIndexOwner.agents.push(this); }
    }
  `,
};
const urls = Object.fromEntries(
  Object.entries(sources).map(([key, source]) => [
    key,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const hook = `
const targets=${JSON.stringify(targets)};const ownerExports=${JSON.stringify(ownerExports)};const urls=${JSON.stringify(urls)};
export async function resolve(specifier,context,nextResolve){
 if(targets.some((target)=>context.parentURL?.endsWith(target)) && urls[specifier]) return {url:urls[specifier],shortCircuit:true};
 return nextResolve(specifier,context);
}
export async function load(url,context,nextLoad){
 const loaded=await nextLoad(url,context);
 const target=targets.find((candidate)=>url.endsWith(candidate));
 if(!target || !ownerExports[target]) return loaded;
 return {...loaded,source:String(loaded.source)+"\\n"+ownerExports[target]+"\\n",shortCircuit:true};
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

(globalThis as any).__chatRuntimeIndexOwner ||= {
  apiCalls: [],
  apiHandlers: {},
  agents: [],
  events: [],
  webSockets: [],
};
