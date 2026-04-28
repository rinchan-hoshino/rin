import { RpcInteractiveSession } from "./runtime.js";

export function createRpcRuntimeHost(session: RpcInteractiveSession) {
  let beforeSessionInvalidate: (() => void) | undefined;
  let rebindSession:
    | ((session: RpcInteractiveSession) => Promise<void>)
    | undefined;

  async function finishReplacement(completed: boolean) {
    if (completed) {
      beforeSessionInvalidate?.();
      await rebindSession?.(session);
    }
    return { cancelled: !completed };
  }

  return {
    get session() {
      return session;
    },
    setBeforeSessionInvalidate(callback?: () => void) {
      beforeSessionInvalidate = callback;
    },
    setRebindSession(
      callback?: (session: RpcInteractiveSession) => Promise<void>,
    ) {
      rebindSession = callback;
    },
    async newSession(options?: { parentSession?: string }) {
      const completed = await session.newSession(options);
      return await finishReplacement(completed);
    },
    async switchSession(sessionPath: string, cwdOverride?: string) {
      const completed = await (session as any).switchSession(
        sessionPath,
        cwdOverride,
      );
      return await finishReplacement(completed);
    },
    async fork(entryId: string) {
      const result = await session.fork(entryId);
      if (!result?.cancelled) {
        beforeSessionInvalidate?.();
        await rebindSession?.(session);
      }
      return result;
    },
    async importFromJsonl(inputPath: string, cwdOverride?: string) {
      const completed = await (session as any).importFromJsonl(
        inputPath,
        cwdOverride,
      );
      return await finishReplacement(completed);
    },
    async dispose() {
      beforeSessionInvalidate?.();
      await session.terminateSession().catch(() => {});
      await session.disconnect();
    },
  };
}
