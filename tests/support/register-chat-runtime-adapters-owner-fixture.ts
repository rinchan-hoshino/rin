import { register } from "node:module";

const target = "dist/core/chat-runtime/adapters.js";
const sources: Record<string, string> = {
  "discord.js": `
    import { EventEmitter } from "node:events";
    export const GatewayIntentBits = { Guilds: 1, GuildMessages: 2, DirectMessages: 4, MessageContent: 8 };
    export const Partials = { Channel: "channel" };
    export const Events = { ClientReady: "ready", MessageCreate: "message", InteractionCreate: "interaction", ShardDisconnect: "disconnect", Error: "error" };
    export class Client extends EventEmitter {
      constructor(options) {
        super();
        this.options = options;
        this.channels = globalThis.__chatRuntimeAdaptersOwner.discordChannels;
        this.guilds = globalThis.__chatRuntimeAdaptersOwner.discordGuilds;
        this.application = globalThis.__chatRuntimeAdaptersOwner.discordApplication;
        this.rest = globalThis.__chatRuntimeAdaptersOwner.discordRest;
        globalThis.__chatRuntimeAdaptersOwner.discordClients.push(this);
      }
      async login(token) {
        globalThis.__chatRuntimeAdaptersOwner.events.push(["discord-login", token]);
        if (globalThis.__chatRuntimeAdaptersOwner.discordLoginError) throw globalThis.__chatRuntimeAdaptersOwner.discordLoginError;
        queueMicrotask(() => this.emit("ready", { user: globalThis.__chatRuntimeAdaptersOwner.discordUser }));
        return token;
      }
      async destroy() {
        globalThis.__chatRuntimeAdaptersOwner.events.push(["discord-destroy"]);
        if (globalThis.__chatRuntimeAdaptersOwner.discordDestroyError) throw globalThis.__chatRuntimeAdaptersOwner.discordDestroyError;
      }
    }
  `,
  "@slack/web-api": `
    export class WebClient {
      constructor(token) {
        globalThis.__chatRuntimeAdaptersOwner.events.push(["slack-web", token]);
        return globalThis.__chatRuntimeAdaptersOwner.slackWeb;
      }
    }
  `,
  "@slack/socket-mode": `
    export class SocketModeClient {
      constructor(options) {
        globalThis.__chatRuntimeAdaptersOwner.events.push(["slack-socket", options]);
        return globalThis.__chatRuntimeAdaptersOwner.slackSocket;
      }
    }
  `,
  "@larksuiteoapi/node-sdk": `
    export const Domain = { Lark: "lark", Feishu: "feishu" };
    export const LoggerLevel = { info: "info" };
    export class Client {
      constructor(options) {
        globalThis.__chatRuntimeAdaptersOwner.events.push(["lark-client", options]);
        return globalThis.__chatRuntimeAdaptersOwner.larkClient;
      }
    }
    export class WSClient {
      constructor(options) {
        globalThis.__chatRuntimeAdaptersOwner.events.push(["lark-ws", options]);
        return globalThis.__chatRuntimeAdaptersOwner.larkWs;
      }
    }
    export class EventDispatcher {
      constructor() { this.handles = new Map(); globalThis.__chatRuntimeAdaptersOwner.larkDispatcher = this; }
      register(record) { for (const [key, value] of Object.entries(record)) this.handles.set(key, value); return this; }
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
        globalThis.__chatRuntimeAdaptersOwner.webSockets.push(this);
        globalThis.__chatRuntimeAdaptersOwner.events.push(["ws-construct", url, options]);
        queueMicrotask(() => {
          const error = globalThis.__chatRuntimeAdaptersOwner.wsOpenError;
          if (error) this.emit("error", error);
          else this.emit("open");
        });
      }
      send(text, callback) {
        const payload = JSON.parse(text);
        globalThis.__chatRuntimeAdaptersOwner.events.push(["ws-send", payload]);
        callback?.(globalThis.__chatRuntimeAdaptersOwner.wsSendError);
        if (!globalThis.__chatRuntimeAdaptersOwner.wsSendError && globalThis.__chatRuntimeAdaptersOwner.wsAutoReply !== false) {
          const response = globalThis.__chatRuntimeAdaptersOwner.wsReply?.(payload) ?? { echo: payload.echo, status: "SUCCESS", message_id: "owner-message" };
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
}
export async function load(url,context,nextLoad){
 const loaded=await nextLoad(url,context);
 if(!url.endsWith(target)) return loaded;
 return {...loaded,source:String(loaded.source)+"\\nexport { compareDiscordMessageIds as __rinOwnerCompareDiscordMessageIds, isOutboundMediaNodeType as __rinOwnerIsOutboundMediaNodeType, larkFileType as __rinOwnerLarkFileType, truncateSlackPlainText as __rinOwnerTruncateSlackPlainText, todoNodeItems as __rinOwnerTodoNodeItems, todoNodeTitle as __rinOwnerTodoNodeTitle, collectionValues as __rinOwnerCollectionValues, permissionSetHasFlag as __rinOwnerPermissionSetHasFlag };\\n",shortCircuit:true};
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

(globalThis as any).__chatRuntimeAdaptersOwner ||= {};
