import {
  RIN_CHAT_PLATFORM_EVENT,
  defineRinExtension,
  type RinChatPlatformContribution,
} from "@hoshinorin/rin/extension";

defineRinExtension((rin) => {
  rin.registerTool({
    name: "pi-compatible-tool",
    label: "Pi-compatible tool",
    description: "Pi APIs remain available",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [], details: {} };
    },
  });
});

const contribution: RinChatPlatformContribution = {
  apiVersion: 1,
  platform: "example",
  async create(input) {
    return {
      bot: {
        platform: "example",
        selfId: "bot",
        status: 0,
        async sendMessage() {
          return ["message"];
        },
      },
      async start() {
        input.logger.info?.("started");
      },
      async stop() {},
    };
  },
};

void RIN_CHAT_PLATFORM_EVENT;
void contribution;
