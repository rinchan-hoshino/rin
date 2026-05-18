import { extractMessageText } from "../message-content.js";
import { continueTodoFinalIfNeeded } from "../rin-lib/todo-state.js";

import { openBoundSession } from "./factory.js";
import { readSessionMetadata } from "./metadata.js";

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
    const text = extractMessageText(event.message.content, { trim: true });
    if (text) latestAssistantText = text;
  });
  const unsubscribe =
    typeof rawUnsubscribe === "function" ? rawUnsubscribe : undefined;
  try {
    latestAssistantText = "";
    await session.prompt(options.prompt, {
      expandPromptTemplates: false,
      source: "rpc" as any,
    });
    await session.agent.waitForIdle();
    if (latestAssistantText) {
      await continueTodoFinalIfNeeded(session, {
        waitForEvents: () => session.agent.waitForIdle(),
      });
    }
    if (!latestAssistantText) throw new Error("final_assistant_text_missing");
    const sessionMeta = readSessionMetadata(session);
    const sessionFile = sessionMeta.sessionFile || undefined;
    const sessionId = sessionMeta.sessionId || undefined;
    return {
      session,
      sessionFile,
      sessionId,
      finalText: latestAssistantText,
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
