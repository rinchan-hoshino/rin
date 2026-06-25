export type ChatBridgeBuiltInAdapterKey =
  | "telegram"
  | "onebot"
  | "qq"
  | "lark"
  | "discord"
  | "slack"
  | "matrix"
  | "minecraft";

export type ChatBridgeAdapterSpec = {
  key: ChatBridgeBuiltInAdapterKey;
  label: string;
  pluginKey: string;
  defaults: Record<string, any>;
};

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

const MATRIX_DEFAULTS = {
  homeserverUrl: "",
  accessToken: "",
  accessTokenFile: "",
  syncTimeoutMs: 30000,
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
    defaults: TELEGRAM_DEFAULTS,
  },
  {
    key: "onebot",
    label: "OneBot",
    pluginKey: "adapter-onebot",
    defaults: ONEBOT_DEFAULTS,
  },
  {
    key: "qq",
    label: "QQ",
    pluginKey: "adapter-qq",
    defaults: QQ_DEFAULTS,
  },
  {
    key: "lark",
    label: "Feishu / Lark",
    pluginKey: "adapter-lark",
    defaults: LARK_DEFAULTS,
  },
  {
    key: "discord",
    label: "Discord",
    pluginKey: "adapter-discord",
    defaults: DISCORD_DEFAULTS,
  },
  {
    key: "slack",
    label: "Slack",
    pluginKey: "adapter-slack",
    defaults: SLACK_DEFAULTS,
  },
  {
    key: "matrix",
    label: "Matrix",
    pluginKey: "adapter-matrix",
    defaults: MATRIX_DEFAULTS,
  },
  {
    key: "minecraft",
    label: "Minecraft / QueQiao",
    pluginKey: "adapter-minecraft",
    defaults: MINECRAFT_DEFAULTS,
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

export function listSupportedChatBridgeLabels() {
  return CHAT_BRIDGE_ADAPTER_SPECS.map((item) => item.label);
}
