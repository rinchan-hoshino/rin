import {
  getEndpointProtocol,
  getChatBridgeAdapterSpec,
  listChatBridgeAdapterSpecs,
} from "./adapters.js";
import type {
  ChatBridgeBuiltInAdapterKey,
  ChatBridgePromptFieldSpec,
  ChatBridgePromptFieldValue,
  ChatBridgePromptFieldValues,
} from "./adapters.js";
import {
  createInstallerI18n,
  type InstallerI18n,
} from "../rin-install/i18n.js";

export type ChatBridgePromptApi = {
  ensureNotCancelled: <T>(value: T | symbol | undefined | null) => T;
  select: (options: any) => Promise<any>;
  text: (options: any) => Promise<any>;
  confirm: (options: any) => Promise<any>;
};

export type ChatBridgeSetupResult = {
  adapterKey: string;
  chatDescription: string;
  chatDetail: string;
  chatConfig: any;
};

function withGuide(
  i18n: InstallerI18n,
  message: string,
  guide?: string,
  links?: string | string[],
) {
  return i18n.buildGuide(message, guide, links);
}

function localizePromptField(
  adapterKey: ChatBridgeBuiltInAdapterKey,
  field: ChatBridgePromptFieldSpec,
  i18n: InstallerI18n,
): ChatBridgePromptFieldSpec {
  if (
    adapterKey === "telegram" &&
    field.key === "token" &&
    field.kind === "text"
  ) {
    return {
      ...field,
      message: withGuide(
        i18n,
        i18n.telegramTokenMessage,
        i18n.telegramTokenGuide,
        "https://t.me/BotFather",
      ),
    };
  }
  if (
    adapterKey === "onebot" &&
    field.key === "endpoint" &&
    field.kind === "url"
  ) {
    return {
      ...field,
      message: withGuide(
        i18n,
        i18n.onebotEndpointMessage,
        i18n.onebotEndpointGuide,
        "https://11.onebot.dev/",
      ),
    };
  }
  if (
    adapterKey === "onebot" &&
    field.key === "selfId" &&
    field.kind === "text"
  ) {
    return {
      ...field,
      message: withGuide(
        i18n,
        i18n.onebotSelfIdMessage,
        i18n.onebotSelfIdGuide,
        "https://11.onebot.dev/",
      ),
    };
  }
  if (
    adapterKey === "onebot" &&
    field.key === "token" &&
    field.kind === "text"
  ) {
    return {
      ...field,
      message: withGuide(
        i18n,
        i18n.onebotTokenMessage,
        i18n.onebotTokenGuide,
        "https://11.onebot.dev/",
      ),
      placeholder: i18n.optionalTokenPlaceholder,
    };
  }
  if (adapterKey === "qq" && field.key === "id" && field.kind === "text") {
    return {
      ...field,
      message: withGuide(
        i18n,
        i18n.qqAppIdMessage,
        i18n.qqCredentialsGuide,
        "https://bot.q.qq.com/wiki/develop/api-v2/",
      ),
    };
  }
  if (adapterKey === "qq" && field.key === "secret" && field.kind === "text") {
    return {
      ...field,
      message: withGuide(
        i18n,
        i18n.qqSecretMessage,
        i18n.qqCredentialsGuide,
        "https://bot.q.qq.com/wiki/develop/api-v2/",
      ),
    };
  }
  if (adapterKey === "qq" && field.key === "token" && field.kind === "text") {
    return {
      ...field,
      message: withGuide(
        i18n,
        i18n.qqTokenMessage,
        i18n.qqCredentialsGuide,
        "https://bot.q.qq.com/wiki/develop/api-v2/",
      ),
    };
  }
  if (adapterKey === "qq" && field.key === "type" && field.kind === "select") {
    return {
      ...field,
      message: withGuide(
        i18n,
        i18n.qqScopeMessage,
        i18n.qqScopeGuide,
        "https://bot.q.qq.com/wiki/develop/api-v2/",
      ),
      values: [
        { value: "public", label: i18n.publicLabel },
        { value: "private", label: i18n.privateLabel },
      ],
    };
  }
  if (
    adapterKey === "lark" &&
    field.key === "platform" &&
    field.kind === "select"
  ) {
    return {
      ...field,
      message: withGuide(
        i18n,
        i18n.larkPlatformMessage,
        i18n.larkPlatformGuide,
        [
          "Feishu https://open.feishu.cn/app?lang=zh-CN",
          "Lark https://open.larksuite.com/",
        ],
      ),
      values: [
        { value: "feishu", label: i18n.feishuLabel, hint: i18n.feishuHint },
        { value: "lark", label: i18n.larkLabel, hint: i18n.larkHint },
      ],
    };
  }
  if (adapterKey === "lark" && field.key === "appId" && field.kind === "text") {
    return {
      ...field,
      message: withGuide(i18n, i18n.larkAppIdMessage, i18n.larkAppIdGuide, [
        "Feishu https://open.feishu.cn/app?lang=zh-CN",
        "Lark https://open.larksuite.com/",
      ]),
    };
  }
  if (
    adapterKey === "lark" &&
    field.key === "appSecret" &&
    field.kind === "text"
  ) {
    return {
      ...field,
      message: withGuide(i18n, i18n.larkAppSecretMessage, i18n.larkAppIdGuide, [
        "Feishu https://open.feishu.cn/app?lang=zh-CN",
        "Lark https://open.larksuite.com/",
      ]),
    };
  }
  if (
    adapterKey === "discord" &&
    field.key === "token" &&
    field.kind === "text"
  ) {
    return {
      ...field,
      message: withGuide(
        i18n,
        i18n.discordTokenMessage,
        i18n.discordTokenGuide,
        "https://discord.com/developers/applications",
      ),
    };
  }
  if (
    adapterKey === "slack" &&
    field.key === "token" &&
    field.kind === "text"
  ) {
    return {
      ...field,
      message: withGuide(
        i18n,
        i18n.slackAppTokenMessage,
        i18n.slackAppTokenGuide,
        "https://api.slack.com/apps",
      ),
    };
  }
  if (
    adapterKey === "slack" &&
    field.key === "botToken" &&
    field.kind === "text"
  ) {
    return {
      ...field,
      message: withGuide(
        i18n,
        i18n.slackBotTokenMessage,
        i18n.slackBotTokenGuide,
        "https://api.slack.com/apps",
      ),
    };
  }
  if (
    adapterKey === "minecraft" &&
    field.key === "url" &&
    field.kind === "url"
  ) {
    return {
      ...field,
      message: withGuide(
        i18n,
        i18n.minecraftUrlMessage,
        i18n.minecraftUrlGuide,
      ),
    };
  }
  if (
    adapterKey === "minecraft" &&
    field.key === "selfId" &&
    field.kind === "text"
  ) {
    return {
      ...field,
      message: i18n.minecraftSelfIdMessage,
    };
  }
  if (
    adapterKey === "minecraft" &&
    field.key === "serverName" &&
    field.kind === "text"
  ) {
    return {
      ...field,
      message: i18n.minecraftServerNameMessage,
    };
  }
  if (
    adapterKey === "minecraft" &&
    field.key === "token" &&
    field.kind === "text"
  ) {
    return {
      ...field,
      message: i18n.minecraftTokenMessage,
      placeholder: i18n.optionalTokenPlaceholder,
    };
  }
  return field;
}

async function promptText(
  prompt: ChatBridgePromptApi,
  options: {
    message: string;
    placeholder?: string;
    defaultValue?: string;
    required?: boolean;
    validate?: (value: string) => string | void;
  },
  i18n: InstallerI18n,
) {
  return String(
    prompt.ensureNotCancelled(
      await prompt.text({
        message: options.message,
        placeholder: options.placeholder,
        defaultValue: options.defaultValue,
        validate(value: string) {
          const next = String(value || "").trim();
          if (options.required && !next) return i18n.fieldRequired;
          return options.validate?.(next);
        },
      }),
    ),
  ).trim();
}

async function promptSelectValue<T extends string>(
  prompt: ChatBridgePromptApi,
  options: {
    message: string;
    values: Array<{ value: T; label: string; hint?: string }>;
  },
) {
  return String(
    prompt.ensureNotCancelled(
      await prompt.select({
        message: options.message,
        options: options.values,
      }),
    ),
  ) as T;
}

async function promptFieldValue(
  prompt: ChatBridgePromptApi,
  adapterKey: ChatBridgeBuiltInAdapterKey,
  field: ChatBridgePromptFieldSpec,
  i18n: InstallerI18n,
): Promise<ChatBridgePromptFieldValue> {
  const localizedField = localizePromptField(adapterKey, field, i18n);
  if (localizedField.kind === "select") {
    return await promptSelectValue(prompt, {
      message: localizedField.message,
      values: localizedField.values,
    });
  }

  const value = await promptText(
    prompt,
    {
      message: localizedField.message,
      placeholder: localizedField.placeholder,
      defaultValue: localizedField.defaultValue,
      required: localizedField.required,
      validate(value) {
        if (localizedField.kind === "url") {
          if (!value && !localizedField.required) return;
          try {
            new URL(value);
          } catch {
            return i18n.validUrlRequired;
          }
        }
        return localizedField.validate?.(value);
      },
    },
    i18n,
  );
  return value || undefined;
}

async function promptFieldValues(
  prompt: ChatBridgePromptApi,
  adapterKey: ChatBridgeBuiltInAdapterKey,
  fields: readonly ChatBridgePromptFieldSpec[],
  i18n: InstallerI18n,
) {
  const values: ChatBridgePromptFieldValues = {};
  for (const field of fields) {
    values[field.key] = await promptFieldValue(prompt, adapterKey, field, i18n);
  }
  return values;
}

function describeConfiguredAdapter(
  adapterKey: ChatBridgeBuiltInAdapterKey,
  values: ChatBridgePromptFieldValues,
  i18n: InstallerI18n,
  fallback: (values: ChatBridgePromptFieldValues) => string,
) {
  switch (adapterKey) {
    case "telegram":
      return i18n.telegramTokenDetail;
    case "onebot": {
      const endpoint = String(values.endpoint || "");
      return i18n.onebotDetail(getEndpointProtocol(endpoint) || "ws", endpoint);
    }
    case "qq":
      return i18n.qqDetail;
    case "lark":
      return i18n.larkDetail(String(values.platform || "feishu"));
    case "discord":
      return i18n.discordDetail;
    case "slack":
      return i18n.slackDetail;
    case "minecraft":
      return i18n.minecraftDetail(String(values.url || ""));
    default:
      return fallback(values);
  }
}

async function promptChatBridgeAdapterConfig(
  prompt: ChatBridgePromptApi,
  adapterKey: ChatBridgeBuiltInAdapterKey,
  i18n: InstallerI18n,
) {
  const adapterSpec = getChatBridgeAdapterSpec(adapterKey);
  const promptDefinition = adapterSpec?.installer.prompt;
  if (!adapterSpec || !promptDefinition) {
    throw new Error(`unsupported_chat_bridge_adapter:${adapterKey}`);
  }

  const values = await promptFieldValues(
    prompt,
    adapterKey,
    promptDefinition.fields,
    i18n,
  );
  return {
    detail: describeConfiguredAdapter(
      adapterKey,
      values,
      i18n,
      promptDefinition.detail,
    ),
    config: promptDefinition.config(values),
  };
}

function adapterSelectHint(
  adapterKey: ChatBridgeBuiltInAdapterKey,
  i18n: InstallerI18n,
) {
  if (adapterKey === "telegram") return i18n.telegramHint;
  if (adapterKey === "onebot") return i18n.onebotHint;
  if (adapterKey === "slack") return i18n.slackHint;
  return i18n.guidedSetupHint;
}

export async function promptChatBridgeSetup(
  prompt: ChatBridgePromptApi,
  options: { confirmEnable?: boolean } = {},
  i18n: InstallerI18n = createInstallerI18n(),
) {
  const shouldConfirmEnable = options.confirmEnable !== false;
  const enableChatBridge = shouldConfirmEnable
    ? prompt.ensureNotCancelled(
        await prompt.confirm({
          message: i18n.configureChatBridgeNowMessage,
          initialValue: false,
        }),
      )
    : true;

  let chatDescription = i18n.chatDisabledDescription;
  let chatDetail = "";
  let chatConfig: any = null;
  let adapterKey = "";
  if (!enableChatBridge) {
    return { adapterKey, chatDescription, chatDetail, chatConfig };
  }

  adapterKey = await promptSelectValue(prompt, {
    message: i18n.chooseChatPlatformMessage,
    values: listChatBridgeAdapterSpecs().map((item) => ({
      value: item.key,
      label: item.label,
      hint: adapterSelectHint(item.key, i18n),
    })),
  });
  const adapterSpec = getChatBridgeAdapterSpec(adapterKey);
  if (!adapterSpec)
    throw new Error(`unsupported_chat_bridge_adapter:${adapterKey}`);

  chatDescription = adapterSpec.label;
  const configured = await promptChatBridgeAdapterConfig(
    prompt,
    adapterSpec.key,
    i18n,
  );
  chatDetail = configured.detail;
  chatConfig = configured.config;

  return {
    adapterKey,
    chatDescription,
    chatDetail,
    chatConfig,
  } as ChatBridgeSetupResult;
}
