import {
  RIN_TURN_TERMINAL_ABSENT,
  resolveRinAuthoritativeTurnTerminalOutcome,
  resolveRinTurnFailureMessage,
  resolveRinTurnTerminalOutcomeFromAssistantMessage,
  resolveRinTurnTerminalOutcomeFromMessages,
  resolveRinTurnTerminalOutcomeFromTurnResult,
  type RinTurnTerminalOutcome,
} from "../rin-frontend-sdk/turn-completion.js";

import { openBoundSession } from "./factory.js";
import { readSessionMetadata } from "./metadata.js";
import { captureTurnScope, readTurnMessages } from "./turn-scope.js";

export async function runSessionPrompt(options: {
  cwd: string;
  agentDir: string;
  prompt: string;
  additionalExtensionPaths?: string[];
  sessionFile?: string;
}) {
  const { session, runtime } = await openBoundSession(options);
  let observedOutcome: RinTurnTerminalOutcome = RIN_TURN_TERMINAL_ABSENT;
  const rawUnsubscribe = session.subscribe?.((event: any) => {
    if (event?.type !== "message_end") return;
    const outcome = resolveRinTurnTerminalOutcomeFromAssistantMessage(
      event.message,
    );
    if (outcome.kind !== "absent") observedOutcome = outcome;
  });
  const unsubscribe =
    typeof rawUnsubscribe === "function" ? rawUnsubscribe : undefined;
  try {
    const turnScope = captureTurnScope(session);
    const promptResult: any = await session.prompt(options.prompt, {
      expandPromptTemplates: false,
      source: "rpc" as any,
    });
    await session.agent.waitForIdle();
    const terminalOutcome = resolveRinAuthoritativeTurnTerminalOutcome(
      resolveRinTurnTerminalOutcomeFromTurnResult(promptResult),
      resolveRinTurnTerminalOutcomeFromMessages(
        readTurnMessages(session, turnScope),
      ),
      observedOutcome,
    );
    if (terminalOutcome.kind === "absent") {
      throw new Error("rin_turn_settled_without_terminal");
    }
    if (terminalOutcome.kind === "error") {
      const producerError =
        resolveRinTurnFailureMessage(
          session,
          terminalOutcome.resolution.messages,
        ) || terminalOutcome.error;
      throw new Error(producerError || "Agent prompt failed.");
    }
    const completion = terminalOutcome.resolution.completion;
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
