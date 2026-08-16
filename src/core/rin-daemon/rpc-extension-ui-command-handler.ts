import type {
  RpcCommandRequest,
  RpcDone,
} from "./rpc-command-handler-context.js";

export type RpcExtensionUiCommandContext = {
  resolvePendingExtensionUiRequest: (...args: any[]) => any;
  done: RpcDone;
};

export function createRpcExtensionUiCommandHandlers(
  context: RpcExtensionUiCommandContext,
) {
  const { resolvePendingExtensionUiRequest, done } = context;
  return {
    async extension_ui_response({ command, id, type }: RpcCommandRequest) {
      resolvePendingExtensionUiRequest(command);
      return done(id, type);
    },
  };
}

export type RpcExtensionUiCommandHandlers = ReturnType<
  typeof createRpcExtensionUiCommandHandlers
>;
