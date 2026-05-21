import { handleRinRpcSessionEvent } from "../rin-frontend-sdk/rpc-session-events.js";

export async function handleRpcSessionEvent(
  target: any,
  payload: any,
  refreshMessages: () => Promise<any>,
  refreshMessagesAndSession: () => Promise<any>,
) {
  return await handleRinRpcSessionEvent(target, payload, {
    refreshMessages,
    refreshMessagesAndSession,
  });
}
