import {
  rpcDone as done,
  type RpcCommandRequest,
  type RpcCommand,
} from "./rpc-command-handler-context.js";

export type RpcExtensionUiCommandContext = {
  resolvePendingExtensionUiRequest: (response: RpcCommand) => boolean;
};

export function createRpcExtensionUiCommandHandlers(
  context: RpcExtensionUiCommandContext,
) {
  const { resolvePendingExtensionUiRequest } = context;
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
