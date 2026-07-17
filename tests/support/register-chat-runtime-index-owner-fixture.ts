import { register } from "node:module";

const target = "dist/core/chat-runtime/index.js";
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
  ws: `
    import { EventEmitter } from "node:events";
    export default class OwnerWebSocket extends EventEmitter {
      static OPEN = 1;
      constructor(url, options) {
        super();
        this.url = url;
        this.options = options;
        this.readyState = OwnerWebSocket.OPEN;
        globalThis.__chatRuntimeIndexOwner.webSockets.push(this);
        globalThis.__chatRuntimeIndexOwner.events.push(["ws-construct", url, options]);
        queueMicrotask(() => {
          const error = globalThis.__chatRuntimeIndexOwner.wsOpenError;
          if (error) this.emit("error", error);
          else this.emit("open");
        });
      }
      send(text, callback) {
        const payload = JSON.parse(text);
        globalThis.__chatRuntimeIndexOwner.events.push(["ws-send", payload]);
        const error = globalThis.__chatRuntimeIndexOwner.wsSendError;
        callback?.(error);
        if (!error && globalThis.__chatRuntimeIndexOwner.wsAutoReply !== false) {
          const response = globalThis.__chatRuntimeIndexOwner.wsReply?.(payload) ?? { echo: payload.echo, status: "ok", retcode: 0, data: { message_id: "owner-message", user_id: 7 } };
          queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify(response))));
        }
      }
      close() { this.readyState = 3; queueMicrotask(() => this.emit("close")); }
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
const target=${JSON.stringify(target)};const urls=${JSON.stringify(urls)};
export async function resolve(specifier,context,nextResolve){
 if(context.parentURL?.endsWith(target) && urls[specifier]) return {url:urls[specifier],shortCircuit:true};
 return nextResolve(specifier,context);
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

(globalThis as any).__chatRuntimeIndexOwner ||= {
  apiCalls: [],
  apiHandlers: {},
  agents: [],
  events: [],
  webSockets: [],
};
