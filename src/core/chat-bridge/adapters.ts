import { safeString } from "../text-utils.js";

export type ChatBridgeBuiltInAdapterKey =
  | "telegram"
  | "onebot"
  | "qq"
  | "lark"
  | "discord"
  | "slack"
  | "minecraft";

export type ChatBridgeAdapterSetupKind = "telegram" | "onebot" | "json";

export type ChatBridgePromptFieldValue = string | undefined;
export type ChatBridgePromptFieldValues = Record<
  string,
  ChatBridgePromptFieldValue
>;

export type ChatBridgeTextPromptFieldSpec = {
  kind: "text" | "url";
  key: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  validate?: (value: string) => string | void;
};

export type ChatBridgeSelectPromptFieldSpec<T extends string = string> = {
  kind: "select";
  key: string;
  message: string;
  values: Array<{ value: T; label: string; hint?: string }>;
};

export type ChatBridgePromptFieldSpec =
  | ChatBridgeTextPromptFieldSpec
  | ChatBridgeSelectPromptFieldSpec;

export type ChatBridgeAdapterPromptDefinition = {
  fields: readonly ChatBridgePromptFieldSpec[];
  detail: (values: ChatBridgePromptFieldValues) => string;
  config: (values: ChatBridgePromptFieldValues) => any;
};

export type ChatBridgeAdapterSpec = {
  key: ChatBridgeBuiltInAdapterKey;
  label: string;
  pluginKey: string;
  packageName: string;
  runtimePackageName?: string;
  defaults: Record<string, any>;
  installer: {
    kind: ChatBridgeAdapterSetupKind;
    placeholder?: string;
    selectHint?: string;
    prompt: ChatBridgeAdapterPromptDefinition;
  };
};

const TELEGRAM_BOTFATHER_URL = "https://t.me/BotFather";
const ONEBOT_DOCS_URL = "https://11.onebot.dev/";
const QQ_BOT_DOCS_URL = "https://bot.q.qq.com/wiki/develop/api-v2/";
const FEISHU_LARK_APP_LINKS = [
  "Feishu https://open.feishu.cn/app?lang=zh-CN",
  "Lark https://open.larksuite.com/",
];
const DISCORD_APPS_URL = "https://discord.com/developers/applications";
const SLACK_APPS_URL = "https://api.slack.com/apps";

function withGuide(message: string, guide?: string, links?: string | string[]) {
  const main = safeString(message).trim();
  const extra = safeString(guide).trim();
  const linkList = (Array.isArray(links) ? links : [links])
    .map((item) => safeString(item).trim())
    .filter(Boolean);
  const lines = [main];
  if (extra) lines.push(`Where to find it: ${extra}`);
  if (linkList.length) lines.push(`Open: ${linkList.join(" · ")}`);
  return lines.join("\n");
}

function textField(
  key: string,
  options: Omit<ChatBridgeTextPromptFieldSpec, "kind" | "key">,
): ChatBridgeTextPromptFieldSpec {
  return { kind: "text", key, ...options };
}

function urlField(
  key: string,
  options: Omit<ChatBridgeTextPromptFieldSpec, "kind" | "key">,
): ChatBridgeTextPromptFieldSpec {
  return { kind: "url", key, ...options };
}

function selectField<T extends string>(
  key: string,
  options: Omit<ChatBridgeSelectPromptFieldSpec<T>, "kind" | "key">,
): ChatBridgeSelectPromptFieldSpec<T> {
  return { kind: "select", key, ...options };
}

function compactObject<T extends Record<string, any>>(value: T) {
  const next: Record<string, any> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (typeof item === "string" && !item.trim()) continue;
    next[key] = item;
  }
  return next as T;
}

function normalizeUrlProtocol(value: unknown) {
  const protocol = safeString(value).trim().toLowerCase();
  if (!protocol) return undefined;
  if (protocol === "http:" || protocol === "https:") return "http";
  if (protocol === "ws:" || protocol === "wss:") return "ws";
  return undefined;
}

export function getEndpointProtocol(endpoint: string | undefined) {
  try {
    return normalizeUrlProtocol(new URL(String(endpoint || "")).protocol);
  } catch {
    return undefined;
  }
}

function validateUrlProtocol(
  value: string,
  allowedProtocols: readonly ("http" | "ws")[],
  errorMessage: string,
) {
  const protocol = getEndpointProtocol(value);
  if (!protocol) return errorMessage;
  if (!allowedProtocols.includes(protocol)) return errorMessage;
  return undefined;
}

function buildBuiltInAdapterConfig(
  adapterKey: ChatBridgeBuiltInAdapterKey,
  defaults: Record<string, any>,
  values: Record<string, any>,
) {
  return {
    [adapterKey]: compactObject({
      ...defaults,
      ...values,
    }),
  };
}

const TELEGRAM_DEFAULTS = {
  protocol: "polling",
  token: "",
  slash: true,
};

const ONEBOT_DEFAULTS = {
  protocol: "ws",
  endpoint: "",
  selfId: "",
  token: "",
};

const QQ_DEFAULTS = {
  protocol: "websocket",
  sandbox: false,
  authType: "bearer",
};

const LARK_DEFAULTS = {
  protocol: "ws",
  platform: "feishu",
};

const DISCORD_DEFAULTS = {};

const SLACK_DEFAULTS = {
  protocol: "ws",
};

const MINECRAFT_DEFAULTS = {
  protocol: "ws",
  url: "",
  selfId: "minecraft",
  serverName: "",
  token: "",
};

const CHAT_BRIDGE_ADAPTER_SPECS: readonly ChatBridgeAdapterSpec[] = [
  {
    key: "telegram",
    label: "Telegram",
    pluginKey: "adapter-telegram",
    packageName: "builtin:telegram",
    defaults: TELEGRAM_DEFAULTS,
    installer: {
      kind: "telegram",
      placeholder:
        '{"token":"123456:ABCDEF...","protocol":"polling","slash":true}',
      selectHint: "bot token",
      prompt: {
        fields: [
          textField("token", {
            message: withGuide(
              "Enter the Telegram bot token.",
              "Telegram @BotFather → choose your bot → API token.",
              TELEGRAM_BOTFATHER_URL,
            ),
            placeholder: "123456:ABCDEF...",
            required: true,
          }),
        ],
        detail: () =>
          "Chat bridge mode: polling · token saved to target settings.json",
        config: ({ token }) =>
          buildBuiltInAdapterConfig("telegram", TELEGRAM_DEFAULTS, { token }),
      },
    },
  },
  {
    key: "onebot",
    label: "OneBot",
    pluginKey: "adapter-onebot",
    packageName: "builtin:onebot",
    defaults: ONEBOT_DEFAULTS,
    installer: {
      kind: "onebot",
      placeholder:
        '{"endpoint":"ws://127.0.0.1:3001","protocol":"ws","selfId":"","token":""}',
      selectHint: "endpoint + protocol",
      prompt: {
        fields: [
          urlField("endpoint", {
            message: withGuide(
              "Enter the OneBot endpoint URL.",
              "Your OneBot bridge or client config, for example NapCat, LLOneBot, or another OneBot server.",
              ONEBOT_DOCS_URL,
            ),
            placeholder: "ws://127.0.0.1:3001",
            required: true,
            validate: (value) =>
              validateUrlProtocol(
                value,
                ["http", "ws"],
                "Use an http(s):// or ws(s):// URL.",
              ),
          }),
          textField("selfId", {
            message: withGuide(
              "Enter the OneBot self ID if you already know it. Leave blank to fill later.",
              "Usually the bot QQ number from your OneBot client or bridge config.",
              ONEBOT_DOCS_URL,
            ),
            placeholder: "123456789",
          }),
          textField("token", {
            message: withGuide(
              "Enter the OneBot access token if required. Leave blank otherwise.",
              "Use the access token from your OneBot server config only if you enabled one.",
              ONEBOT_DOCS_URL,
            ),
            placeholder: "optional token",
          }),
        ],
        detail: ({ endpoint }) => {
          const protocol =
            getEndpointProtocol(endpoint) || ONEBOT_DEFAULTS.protocol;
          return `Chat bridge mode: ${protocol} · endpoint: ${endpoint}`;
        },
        config: ({ endpoint, selfId, token }) =>
          buildBuiltInAdapterConfig("onebot", ONEBOT_DEFAULTS, {
            endpoint,
            protocol: getEndpointProtocol(endpoint) || ONEBOT_DEFAULTS.protocol,
            selfId,
            token,
          }),
      },
    },
  },
  {
    key: "qq",
    label: "QQ",
    pluginKey: "adapter-qq",
    packageName: "builtin:qq",
    defaults: QQ_DEFAULTS,
    installer: {
      kind: "json",
      placeholder: '{"id":"...","secret":"...","token":"..."}',
      selectHint: "guided setup",
      prompt: {
        fields: [
          textField("id", {
            message: withGuide(
              "Enter the QQ bot app ID.",
              "QQ bot developer docs → create your bot application → app credentials.",
              QQ_BOT_DOCS_URL,
            ),
            placeholder: "App ID",
            required: true,
          }),
          textField("secret", {
            message: withGuide(
              "Enter the QQ bot secret.",
              "QQ bot developer docs → create your bot application → app credentials.",
              QQ_BOT_DOCS_URL,
            ),
            placeholder: "Secret",
            required: true,
          }),
          textField("token", {
            message: withGuide(
              "Enter the QQ bot token.",
              "QQ bot developer docs → your bot application → token / credentials.",
              QQ_BOT_DOCS_URL,
            ),
            placeholder: "Token",
            required: true,
          }),
          selectField("type", {
            message: withGuide(
              "Choose the QQ bot scope.",
              "Use the bot type shown in your QQ bot application settings.",
              QQ_BOT_DOCS_URL,
            ),
            values: [
              { value: "public", label: "Public" },
              { value: "private", label: "Private" },
            ],
          }),
        ],
        detail: () =>
          "Chat bridge mode: websocket · app credentials saved to target settings.json",
        config: ({ id, secret, token, type }) =>
          buildBuiltInAdapterConfig("qq", QQ_DEFAULTS, {
            id,
            secret,
            token,
            type,
          }),
      },
    },
  },
  {
    key: "lark",
    label: "Feishu / Lark",
    pluginKey: "adapter-lark",
    packageName: "builtin:lark",
    defaults: LARK_DEFAULTS,
    installer: {
      kind: "json",
      placeholder: '{"platform":"feishu","appId":"...","appSecret":"..."}',
      selectHint: "guided setup",
      prompt: {
        fields: [
          selectField("platform", {
            message: withGuide(
              "Choose the Lark / Feishu region.",
              "If your app is on open.feishu.cn use Feishu. If it is on open.larksuite.com use Lark.",
              FEISHU_LARK_APP_LINKS,
            ),
            values: [
              {
                value: "feishu",
                label: "Feishu",
                hint: "China / open.feishu.cn",
              },
              {
                value: "lark",
                label: "Lark",
                hint: "Global / open.larksuite.com",
              },
            ],
          }),
          textField("appId", {
            message: withGuide(
              "Enter the Lark / Feishu app ID.",
              "Developer console → your app → Credentials / Basic information.",
              FEISHU_LARK_APP_LINKS,
            ),
            placeholder: "App ID",
            required: true,
          }),
          textField("appSecret", {
            message: withGuide(
              "Enter the Lark / Feishu app secret.",
              "Developer console → your app → Credentials / Basic information.",
              FEISHU_LARK_APP_LINKS,
            ),
            placeholder: "App secret",
            required: true,
          }),
        ],
        detail: ({ platform }) =>
          `Chat bridge mode: ws · platform: ${platform} · app credentials saved to target settings.json`,
        config: ({ platform, appId, appSecret }) =>
          buildBuiltInAdapterConfig("lark", LARK_DEFAULTS, {
            platform,
            appId,
            appSecret,
          }),
      },
    },
  },
  {
    key: "discord",
    label: "Discord",
    pluginKey: "adapter-discord",
    packageName: "builtin:discord",
    defaults: DISCORD_DEFAULTS,
    installer: {
      kind: "json",
      placeholder: '{"token":"..."}',
      selectHint: "guided setup",
      prompt: {
        fields: [
          textField("token", {
            message: withGuide(
              "Enter the Discord bot token.",
              "Discord Developer Portal → your application → Bot → Reset Token / Token.",
              DISCORD_APPS_URL,
            ),
            placeholder: "Bot token",
            required: true,
          }),
        ],
        detail: () => "Chat bridge token: [saved to target settings.json]",
        config: ({ token }) =>
          buildBuiltInAdapterConfig("discord", DISCORD_DEFAULTS, { token }),
      },
    },
  },
  {
    key: "slack",
    label: "Slack",
    pluginKey: "adapter-slack",
    packageName: "builtin:slack",
    defaults: SLACK_DEFAULTS,
    installer: {
      kind: "json",
      placeholder: '{"protocol":"ws","token":"xapp-...","botToken":"xoxb-..."}',
      selectHint: "app token + bot token",
      prompt: {
        fields: [
          textField("token", {
            message: withGuide(
              "Enter the Slack app-level token.",
              "Slack app settings → Basic Information or Socket Mode → App-Level Tokens (starts with xapp-).",
              SLACK_APPS_URL,
            ),
            placeholder: "xapp-...",
            required: true,
          }),
          textField("botToken", {
            message: withGuide(
              "Enter the Slack bot token.",
              "Slack app settings → OAuth & Permissions → Bot User OAuth Token (starts with xoxb-).",
              SLACK_APPS_URL,
            ),
            placeholder: "xoxb-...",
            required: true,
          }),
        ],
        detail: () => "Chat bridge mode: ws",
        config: ({ token, botToken }) =>
          buildBuiltInAdapterConfig("slack", SLACK_DEFAULTS, {
            token,
            botToken,
          }),
      },
    },
  },
  {
    key: "minecraft",
    label: "Minecraft / QueQiao",
    pluginKey: "adapter-minecraft",
    packageName: "builtin:minecraft",
    defaults: MINECRAFT_DEFAULTS,
    installer: {
      kind: "json",
      placeholder:
        '{"url":"ws://127.0.0.1:8080","selfId":"minecraft","serverName":"Survival","token":"..."}',
      selectHint: "guided setup",
      prompt: {
        fields: [
          urlField("url", {
            message: withGuide(
              "Enter the Minecraft QueQiao WebSocket URL.",
              "Use the WebSocket address exposed by your QueQiao bridge or Minecraft adapter.",
            ),
            placeholder: "ws://127.0.0.1:8080",
            required: true,
            validate: (value) =>
              validateUrlProtocol(value, ["ws"], "Use a ws:// or wss:// URL."),
          }),
          textField("selfId", {
            message:
              "Enter the Minecraft bridge self ID if you want a custom one. Leave blank to use minecraft.",
            placeholder: "minecraft",
          }),
          textField("serverName", {
            message:
              "Enter the Minecraft server name if you want it shown in chat logs. Leave blank otherwise.",
            placeholder: "Survival",
          }),
          textField("token", {
            message:
              "Enter the QueQiao access token if required. Leave blank otherwise.",
            placeholder: "optional token",
          }),
        ],
        detail: ({ url }) => `Chat bridge mode: ws · endpoint: ${url}`,
        config: ({ url, selfId, serverName, token }) =>
          buildBuiltInAdapterConfig("minecraft", MINECRAFT_DEFAULTS, {
            url,
            selfId,
            serverName,
            token,
          }),
      },
    },
  },
];

const CHAT_BRIDGE_ADAPTER_SPEC_MAP = new Map(
  CHAT_BRIDGE_ADAPTER_SPECS.map((item) => [item.key, item]),
);

export function listChatBridgeAdapterSpecs() {
  return [...CHAT_BRIDGE_ADAPTER_SPECS];
}

export function getChatBridgeAdapterSpec(key: string) {
  return CHAT_BRIDGE_ADAPTER_SPEC_MAP.get(
    String(key || "").trim() as ChatBridgeBuiltInAdapterKey,
  );
}

export function listChatBridgeAdapterPromptOptions() {
  return CHAT_BRIDGE_ADAPTER_SPECS.map((item) => ({
    value: item.key,
    label: item.label,
    hint: item.installer.selectHint,
  }));
}

export function listSupportedChatBridgeLabels() {
  return CHAT_BRIDGE_ADAPTER_SPECS.map((item) => item.label);
}
