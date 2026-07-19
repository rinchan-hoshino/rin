import {
  countToolCalls,
  extractMessageText,
  isAssistantFailedMessage,
} from "../message-content.js";

import { openBoundSession } from "./factory.js";
import { readSessionMetadata } from "./metadata.js";
import { resolveTurnCompletion } from "./turn-result.js";

export async function runSessionPrompt(options: {
  cwd: string;
  agentDir: string;
  prompt: string;
  additionalExtensionPaths?: string[];
  sessionFile?: string;
}) {
  const { session, runtime } = await openBoundSession(options);
  let latestAssistantText = "";
  const rawUnsubscribe = session.subscribe?.((event: any) => {
    if (event?.type !== "message_end") return;
    if (event?.message?.role !== "assistant") return;
    if (
      !isAssistantFailedMessage(event.message) &&
      countToolCalls(event.message.content) > 0
    ) {
      return;
    }
    const text = extractMessageText(event.message.content, { trim: true });
    if (text) latestAssistantText = text;
  });
  const unsubscribe =
    typeof rawUnsubscribe === "function" ? rawUnsubscribe : undefined;
  try {
    latestAssistantText = "";
    const manager = session.sessionManager;
    const branchBefore = manager?.getBranch?.();
    if (
      !Array.isArray(branchBefore) ||
      typeof manager?.getLeafId !== "function"
    ) {
      throw new Error(
        "Rin session branch cursor is unavailable before the turn starts.",
      );
    }
    const rawBranchCursor = manager.getLeafId();
    const branchCursor =
      typeof rawBranchCursor === "string" && rawBranchCursor.length > 0
        ? rawBranchCursor
        : null;
    const baselineLeafId = branchBefore.at(-1)?.id;
    if (
      (rawBranchCursor != null && branchCursor === null) ||
      (branchBefore.length === 0 && branchCursor !== null) ||
      (branchBefore.length > 0 &&
        (typeof baselineLeafId !== "string" ||
          baselineLeafId.length === 0 ||
          baselineLeafId !== branchCursor))
    ) {
      throw new Error(
        "Rin session branch cursor is unavailable before the turn starts.",
      );
    }
    const promptResult: any = await session.prompt(options.prompt, {
      expandPromptTemplates: false,
      source: "rpc" as any,
    });
    await session.agent.waitForIdle();
    if (session.sessionManager !== manager) {
      throw new Error(
        "Rin session branch ownership changed while the turn was running.",
      );
    }
    const branch = manager.getBranch();
    const managerLeafId = manager.getLeafId();
    const branchLeafId = Array.isArray(branch) ? branch.at(-1)?.id : undefined;
    if (
      !Array.isArray(branch) ||
      (branch.length === 0 && managerLeafId != null) ||
      (branch.length > 0 &&
        (typeof branchLeafId !== "string" ||
          branchLeafId.length === 0 ||
          branchLeafId !== managerLeafId))
    ) {
      throw new Error(
        "Rin session branch ownership changed while the turn was running.",
      );
    }
    const cursorIndex = branchCursor
      ? branch.findIndex((entry: any) => entry?.id === branchCursor)
      : -1;
    if (branchCursor && cursorIndex < 0) {
      throw new Error(
        "Rin session branch ownership changed while the turn was running.",
      );
    }
    const turnMessages = (branchCursor ? branch.slice(cursorIndex + 1) : branch)
      .filter((entry: any) => entry?.type === "message")
      .map((entry: any) => entry.message);
    const terminalMessage = [...turnMessages]
      .reverse()
      .find(
        (message: any) =>
          message?.role === "assistant" &&
          (isAssistantFailedMessage(message) ||
            countToolCalls(message?.content) === 0),
      );
    if (terminalMessage && isAssistantFailedMessage(terminalMessage)) {
      const producerError = String(
        terminalMessage.errorMessage ||
          terminalMessage.error ||
          session.agent?.state?.errorMessage ||
          "Agent prompt failed.",
      ).trim();
      throw new Error(producerError || "Agent prompt failed.");
    }
    const completion = resolveTurnCompletion({
      result: promptResult?.result ?? promptResult,
      messages: terminalMessage ? [terminalMessage] : undefined,
      finalText: latestAssistantText || promptResult?.finalText,
    });
    const sessionMeta = readSessionMetadata(session);
    const sessionFile = sessionMeta.sessionFile || undefined;
    const sessionId = sessionMeta.sessionId || undefined;
    return {
      session,
      sessionFile,
      sessionId,
      finalText: completion.finalText,
    };
  } finally {
    try {
      unsubscribe?.();
    } catch {}
    try {
      await session.abort();
    } catch {}
    try {
      await runtime.dispose();
    } catch {}
  }
}
