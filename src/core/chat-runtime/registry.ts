import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { Api as GrammyApi, InputFile } from "grammy";
import { Agent as UndiciAgent } from "undici";
import WebSocket from "ws";

import { getWorkingReactionFrame } from "../chat/transport.js";
import { enqueueChatInboxItem } from "../chat/inbox.js";
import { getChatId, pickMessageId } from "../chat/chat-helpers.js";
import {
  getChatBridgeAdapterSpec,
  type ChatBridgeBuiltInAdapterKey,
} from "../chat-bridge/adapters.js";
import { composeChatKeyForBot } from "../chat/support.js";
import {
  compactObject,
  createPrefixedLogger,
  editableWorkingText,
  emitBotStatus,
  ensureDir,
  ensureExtension,
  ensureFileName,
  fileUrl,
  isEditableProgressDeliveryKind,
  normalizeNode,
  prepareOutboundNodes,
  randomWorkingText,
  readBinaryFromNode,
  renderMarkdownFromNodes,
  renderPlainTextFromNodes,
  renderRichDeliveryErrorPlaceholder,
  renderTelegramHtmlFromNodes,
  resolveChatRuntimeWorkingCopy,
  safeString,
  sleep,
  splitPlainText,
  stageChatMediaFromNode,
} from "./common.js";
import { EditableTextMessageGroup } from "./editable-text-message-group.js";
import {
  DiscordAdapter,
  LarkAdapter,
  MinecraftAdapter,
  QQAdapter,
  SlackAdapter,
} from "./adapters.js";

import { ChatRuntimeApp, createNodeBuilder } from "./runtime-app.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import { OneBotAdapter } from "./adapters/onebot.js";

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
  qq: QQAdapter,
  lark: LarkAdapter,
  discord: DiscordAdapter,
  slack: SlackAdapter,
  minecraft: MinecraftAdapter,
};

export function createChatRuntimeApp(agentDir?: string) {
  return new ChatRuntimeApp(agentDir);
}

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
      input.logger?.warn?.(
        `chat runtime adapter init failed key=${entry.key} name=${entry.name} err=${safeString(error?.message || error)}`,
      );
    }
  }
  return created;
}
