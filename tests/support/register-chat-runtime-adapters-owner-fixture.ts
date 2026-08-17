import "./require-test-sandbox.ts";
import { register } from "node:module";

const target = "dist/core/chat/platform/discord.js";
const ownerExport =
  "export { compareDiscordMessageIds as __rinOwnerCompareDiscordMessageIds, isOutboundMediaNodeType as __rinOwnerIsOutboundMediaNodeType, collectionValues as __rinOwnerCollectionValues, permissionSetHasFlag as __rinOwnerPermissionSetHasFlag, discordChannelDisplayName as __rinOwnerDiscordChannelDisplayName, findDiscordChannelById as __rinOwnerFindDiscordChannelById, resolveDiscordParentChannel as __rinOwnerResolveDiscordParentChannel };";
const discordSource = `
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
`;
const discordUrl = `data:text/javascript,${encodeURIComponent(discordSource)}`;
const hook = `
const target=${JSON.stringify(target)};const ownerExport=${JSON.stringify(ownerExport)};const discordUrl=${JSON.stringify(discordUrl)};
export async function resolve(specifier,context,nextResolve){
 if(context.parentURL?.endsWith(target) && specifier==="discord.js") return {url:discordUrl,shortCircuit:true};
 return nextResolve(specifier,context);
}
export async function load(url,context,nextLoad){
 const loaded=await nextLoad(url,context);
 if(!url.endsWith(target)) return loaded;
 return {...loaded,source:String(loaded.source)+"\\n"+ownerExport+"\\n",shortCircuit:true};
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

(globalThis as any).__chatRuntimeAdaptersOwner ||= {};
