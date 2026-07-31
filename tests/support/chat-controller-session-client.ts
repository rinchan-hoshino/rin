function sessionState(session) {
  return {
    sessionFile: session?.sessionManager?.getSessionFile?.(),
    sessionId: session?.sessionManager?.getSessionId?.(),
    isStreaming: Boolean(session?.isStreaming),
  };
}

function createSessionFrontendClient(controller) {
  let connected = false;
  const state = () => sessionState(controller.session);
  return {
    async connect() {
      connected = true;
    },
    async disconnect() {
      connected = false;
      await controller.session?.disconnect?.();
    },
    isConnected() {
      return connected;
    },
    subscribe() {
      return () => {};
    },
    async prompt(text, options = {}) {
      return await controller.session?.prompt?.(text, options);
    },
    async steer(text, options = {}) {
      return await controller.session?.steer?.(text, options);
    },
    async getState() {
      return state();
    },
    async ensureSessionReady(restoreSessionFile = "", managedSessionLeaf = "") {
      if (managedSessionLeaf && !restoreSessionFile) {
        const completed = await controller.session?.newSession?.({
          managedSessionLeaf,
        });
        if (completed === false) throw new Error("rin_new_session_cancelled");
      } else if (restoreSessionFile) {
        await controller.session?.switchSession?.(restoreSessionFile);
      }
      const ready = await controller.session?.ensureSessionReady?.();
      return { ...state(), ...(ready || {}) };
    },
    async abort() {
      if (typeof controller.session?.agent?.abort === "function") {
        controller.session.agent.abort();
        return;
      }
      await controller.session?.abort?.();
    },
    async request(command = {}) {
      const sessionFile = String(command?.sessionFile || "").trim();
      const current =
        controller.session?.sessionManager?.getSessionFile?.() || "";
      if (sessionFile && current !== sessionFile) {
        await controller.session?.switchSession?.(sessionFile);
      }
      switch (command?.type) {
        case "get_state":
          return state();
        case "get_messages":
          return { messages: await this.getMessages() };
        case "run_command":
          return await this.runCommand(String(command.commandLine || ""));
        case "reset_model_options_from_settings":
          return await this.resetModelOptionsFromSettings();
        case "set_model":
          return await this.setModel(
            String(command.provider || ""),
            String(command.modelId || ""),
          );
        case "set_thinking_level":
          return await this.setThinkingLevel(String(command.level || ""));
        default:
          return {};
      }
    },
    async send(command) {
      return { type: "response", command: command?.type, success: true };
    },
    async submit(text) {
      return await this.prompt(text);
    },
    async getMessages() {
      return Array.isArray(controller.session?.messages)
        ? controller.session.messages
        : [];
    },
    async getCommands() {
      return [];
    },
    async runCommand(commandLine) {
      return await controller.session?.runCommand?.(commandLine);
    },
    async compact(customInstructions) {
      if (typeof controller.session?.compact === "function") {
        return await controller.session.compact(customInstructions);
      }
      return await controller.session?.runCommand?.(
        customInstructions ? `/compact ${customInstructions}` : "/compact",
      );
    },
    async getAutocompleteItems() {
      return [];
    },
    async getCommandArgumentCompletions() {
      return [];
    },
    async listSessions() {
      return [];
    },
    async resumeSession(sessionId) {
      await controller.session?.switchSession?.(sessionId);
    },
    async newSession(options = {}) {
      const completed = await controller.session?.newSession?.(options);
      return {
        cancelled: completed === false || Boolean(completed?.cancelled),
        ...state(),
      };
    },
    async listModels() {
      const models = await controller.session?.modelRegistry?.getAvailable?.();
      return Array.isArray(models) ? models : [];
    },
    async setModel(provider, modelId) {
      const models = await this.listModels();
      const model = models.find(
        (item) => item?.provider === provider && item?.id === modelId,
      );
      if (!model)
        throw new Error(`chat_model_not_found:${provider}/${modelId}`);
      await controller.session?.setModel?.(model);
      return model;
    },
    async setThinkingLevel(level) {
      if (controller.session) controller.session.thinkingLevel = level;
      return { level };
    },
    async resetModelOptionsFromSettings() {
      return await controller.session?.resetModelOptionsFromSettings?.();
    },
    async respondExtensionUi() {},
  };
}

export function installChatControllerSessionClient(ChatController) {
  Object.defineProperty(ChatController.prototype, "session", {
    configurable: true,
    get() {
      return this.__testSession || null;
    },
    set(value) {
      this.__testSession = value;
      this.client = value ? createSessionFrontendClient(this) : null;
    },
  });
}
