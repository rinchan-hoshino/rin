import {
  getChatBridgeAdapterSpec,
  type ChatBridgeBuiltInAdapterKey,
} from "../chat-bridge/adapters.js";
import { compactObject, normalizeNode, safeString } from "./common.js";
import { DiscordAdapter } from "./discord.js";
import { LarkAdapter } from "./lark.js";
import { OneBotAdapter } from "./onebot.js";
import { SlackAdapter } from "./slack.js";
import { TelegramAdapter } from "./telegram.js";
import type { ChatRuntimeApp } from "./app.js";

function createNodeBuilder() {
  const h: any = (
    type: string,
    attrs?: Record<string, any>,
    ...children: any[]
  ) => normalizeNode(type, attrs, children);
  h.text = (content: unknown) =>
    normalizeNode("text", { content: safeString(content) });
  h.quote = (id: unknown) => normalizeNode("quote", { id: safeString(id) });
  h.at = (id: unknown, attrs?: Record<string, any>) =>
    normalizeNode(
      "at",
      compactObject({ ...(attrs || {}), id: safeString(id) }),
    );
  h.image = (src: unknown) => normalizeNode("image", { src: safeString(src) });
  h.markdown = (content: unknown) =>
    normalizeNode("markdown", { content: safeString(content) });
  h.html = (content: unknown) =>
    normalizeNode("html", { content: safeString(content) });
  h.file = (value: unknown, mimeType?: string, attrs?: Record<string, any>) => {
    const base = compactObject({
      ...(attrs || {}),
      mimeType: safeString(mimeType).trim() || undefined,
    });
    if (Buffer.isBuffer(value))
      return normalizeNode("file", { ...base, data: value });
    return normalizeNode("file", { ...base, src: safeString(value) });
  };
  return h;
}

type BuiltInChatRuntimeAdapterConstructor = new (
  app: ChatRuntimeApp,
  dataDir: string,
  config: Record<string, any>,
  logger: any,
) => any;

export type ChatRuntimeExternalAdapterProviderInput = {
  app: ChatRuntimeApp;
  agentDir?: string;
  dataDir: string;
  runtimeRoot?: string;
  h?: any;
  key: string;
  name: string;
  packageName?: string;
  config: Record<string, any>;
  logger?: any;
};

export type ChatRuntimeExternalAdapterProviderResult = void | {
  adapter?: any;
  bot?: any;
};

export type ChatRuntimeExternalAdapterProvider =
  | ((
      input: ChatRuntimeExternalAdapterProviderInput,
    ) =>
      | ChatRuntimeExternalAdapterProviderResult
      | Promise<ChatRuntimeExternalAdapterProviderResult>)
  | {
      createAdapter(
        input: ChatRuntimeExternalAdapterProviderInput,
      ):
        | ChatRuntimeExternalAdapterProviderResult
        | Promise<ChatRuntimeExternalAdapterProviderResult>;
    };

export type ChatRuntimeExternalAdapterEntry = {
  key: string;
  name: string;
  packageName?: string;
  config: Record<string, any>;
  provider: ChatRuntimeExternalAdapterProvider;
};

const BUILT_IN_CHAT_RUNTIME_ADAPTER_FACTORIES: Record<
  ChatBridgeBuiltInAdapterKey,
  BuiltInChatRuntimeAdapterConstructor
> = {
  telegram: TelegramAdapter,
  onebot: OneBotAdapter,
  lark: LarkAdapter,
  discord: DiscordAdapter,
  slack: SlackAdapter,
};

export function createChatRuntimeH() {
  return createNodeBuilder();
}

type ChatRuntimeAdapterInstantiationInput = {
  dataDir: string;
  adapterEntries: Array<{
    key: string;
    name: string;
    config: Record<string, any>;
  }>;
  logger?: any;
};

function instantiateBuiltInChatRuntimeAdapter(
  app: ChatRuntimeApp,
  input: ChatRuntimeAdapterInstantiationInput,
  entry: ChatRuntimeAdapterInstantiationInput["adapterEntries"][number],
) {
  const adapterSpec = getChatBridgeAdapterSpec(entry.key);
  const Adapter = adapterSpec
    ? BUILT_IN_CHAT_RUNTIME_ADAPTER_FACTORIES[adapterSpec.key]
    : undefined;
  if (!Adapter) {
    input.logger?.warn?.(
      `chat runtime adapter not implemented key=${entry.key} name=${entry.name}`,
    );
    return false;
  }
  new Adapter(app, input.dataDir, entry.config, input.logger);
  return true;
}

export function instantiateBuiltInChatRuntimeAdapters(
  app: ChatRuntimeApp,
  input: ChatRuntimeAdapterInstantiationInput,
) {
  const created: Array<{ key: string; name: string }> = [];
  for (const entry of input.adapterEntries) {
    try {
      if (instantiateBuiltInChatRuntimeAdapter(app, input, entry)) {
        created.push({ key: entry.key, name: entry.name });
      }
    } catch (error: any) {
      app.registerAdapterFailure(
        { platform: entry.key, selfId: entry.name },
        error,
      );
      input.logger?.warn?.(
        `chat runtime adapter init failed key=${entry.key} name=${entry.name} err=${safeString(error?.message || error)}`,
      );
    }
  }
  return created;
}

async function instantiateExternalChatRuntimeAdapter(
  app: ChatRuntimeApp,
  input: {
    agentDir?: string;
    dataDir: string;
    runtimeRoot?: string;
    h?: any;
    logger?: any;
  },
  entry: ChatRuntimeExternalAdapterEntry,
) {
  const botCountBefore = app.bots.length;
  const provider: any = entry.provider;
  const createAdapter =
    typeof provider === "function" ? provider : provider?.createAdapter;
  if (typeof createAdapter !== "function") {
    throw new Error("external_chat_adapter_missing_createAdapter");
  }
  const result = await createAdapter({
    app,
    agentDir: input.agentDir,
    dataDir: input.dataDir,
    runtimeRoot: input.runtimeRoot,
    h: input.h,
    key: entry.key,
    name: entry.name,
    packageName: entry.packageName,
    config: entry.config,
    logger: input.logger,
  });
  if (result && (result.adapter || result.bot)) {
    if (!result.adapter || !result.bot) {
      throw new Error("external_chat_adapter_return_requires_adapter_and_bot");
    }
    app.register(result.adapter, result.bot);
  } else if (result && typeof result === "object") {
    throw new Error("external_chat_adapter_return_requires_adapter_and_bot");
  }
  if (app.bots.length <= botCountBefore) {
    throw new Error("external_chat_adapter_did_not_register_bot");
  }
}

export async function instantiateExternalChatRuntimeAdapters(
  app: ChatRuntimeApp,
  input: {
    agentDir?: string;
    dataDir: string;
    runtimeRoot?: string;
    h?: any;
    adapterEntries: ChatRuntimeExternalAdapterEntry[];
    logger?: any;
  },
) {
  const created: Array<{ key: string; name: string }> = [];
  for (const entry of input.adapterEntries) {
    try {
      await instantiateExternalChatRuntimeAdapter(app, input, entry);
      created.push({ key: entry.key, name: entry.name });
    } catch (error: any) {
      app.registerAdapterFailure(
        { platform: entry.key, selfId: entry.name },
        error,
      );
      input.logger?.warn?.(
        `external chat runtime adapter init failed key=${entry.key} name=${entry.name} err=${safeString(error?.message || error)}`,
      );
    }
  }
  return created;
}

export async function instantiateChatRuntimeAdapters(
  app: ChatRuntimeApp,
  input: ChatRuntimeAdapterInstantiationInput,
) {
  const created: Array<{ key: string; name: string }> = [];
  for (const entry of input.adapterEntries) {
    try {
      if (instantiateBuiltInChatRuntimeAdapter(app, input, entry)) {
        created.push({ key: entry.key, name: entry.name });
      }
    } catch (error: any) {
      app.registerAdapterFailure(
        { platform: entry.key, selfId: entry.name },
        error,
      );
      input.logger?.warn?.(
        `chat runtime adapter init failed key=${entry.key} name=${entry.name} err=${safeString(error?.message || error)}`,
      );
    }
  }
  return created;
}
