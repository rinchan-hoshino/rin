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
      ctx.ui.setMessageCatalog?.({
        "session.new.completed": "Started.",
      });
      ctx.ui.setWorkingMessage("Working");
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
      const chatKeys = await ctx.chat.listKeys({
        platform: "discord",
        accountIds: ["1"],
      });
      const bindings = await ctx.chat.getSessionBindings([
        ...chatKeys,
        "telegram/2:20",
      ]);
      const states = await ctx.sessions.getStates(bindings);
      const state: "idle" | "executing" | "waiting" = states[0];
      ctx.logger.info?.(`state ${state}`);
      return { stop() {} };
    },
  });
});
