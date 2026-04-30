import { RpcInteractiveSession } from "./runtime.js";

export function createRpcRuntimeHost(session: RpcInteractiveSession) {
  let beforeSessionInvalidate: (() => void) | undefined;
  let rebindSession:
    | ((session: RpcInteractiveSession) => Promise<void>)
    | undefined;

  async function finishReplacement(
    completed: boolean,
    event?: Record<string, unknown>,
  ) {
    if (completed) {
      beforeSessionInvalidate?.();
      await (session as any).shutdownLocalExtensions?.(
        event || { reason: "resume" },
      );
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
    async newSession(options?: {
      parentSession?: string;
      managedSessionLeaf?: string;
    }) {
      const completed = await session.newSession(options);
      return await finishReplacement(completed, { reason: "new" });
    },
    async switchSession(
      sessionPath: string,
      options?: {
        cwdOverride?: string;
        withSession?: (ctx: any) => Promise<void>;
      },
    ) {
      const completed = await (session as any).switchSession(
        sessionPath,
        options,
      );
      return await finishReplacement(completed, {
        reason: "resume",
        targetSessionFile: sessionPath,
      });
    },
    async fork(
      entryId: string,
      options?: {
        position?: "before" | "at";
        withSession?: (ctx: any) => Promise<void>;
      },
    ) {
      const result = await (session as any).fork(entryId, options);
      if (!result?.cancelled) {
        beforeSessionInvalidate?.();
        await (session as any).shutdownLocalExtensions?.({ reason: "fork" });
        await rebindSession?.(session);
      }
      return result;
    },
    async importFromJsonl(inputPath: string, cwdOverride?: string) {
      const completed = await (session as any).importFromJsonl(
        inputPath,
        cwdOverride,
      );
      return await finishReplacement(completed, { reason: "resume" });
    },
    async dispose() {
      beforeSessionInvalidate?.();
      await (session as any).shutdownLocalExtensions?.({ reason: "quit" });
      await session.terminateSession().catch(() => {});
      await session.disconnect();
    },
  };
}
