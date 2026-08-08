import {
  defineRinDaemonExtension,
  defineRinExtension,
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
  rin.registerCommand("chat-command", {
    description: "A typed Rin chat command",
    chat: true,
    async handler(args, ctx) {
      ctx.ui.notify(args || "ok", "info");
      ctx.ui.rinCommandResult?.({
        fallbackText: args || "ok",
        parts: [{ type: "image", path: "/tmp/result.png" }],
      });
    },
  });
  rin.registerCommand("tui-command", {
    description: "A Pi-compatible command",
    async handler() {},
  });
});

defineRinDaemonExtension((rin) => {
  rin.registerBackgroundService({
    async start(ctx) {
      ctx.logger.info?.(`starting ${ctx.name}`);
      return { stop() {} };
    },
  });
});
