import type { PromptContextMeta } from "../rin-lib/prompt-context.js";

export type ChatInboxAdmissionState =
  | "unclassified"
  | "actionable"
  | "record_only";

export type FrozenChatTurnSubmission = {
  version: 1;
  chatKey: string;
  text: string;
  attachments: any[];
  promptMeta: PromptContextMeta;
  deliverFinal?: boolean;
  quietMode?: boolean;
  incomingMessageId: string;
  replyToMessageId?: string;
  sessionFile?: string;
  model?: string;
  thinkingLevel?: string;
  receivedAt?: string;
};

export type DurableChatAdmissionDecision =
  | { version: 1; kind: "message"; decision: unknown }
  | {
      version: 1;
      kind: "command";
      chatKey: string;
      messageId: string;
      command: { name: string; argsText: string };
      trust: string;
      promptMeta: PromptContextMeta;
    }
  | {
      version: 1;
      kind: "nerve_owner_message";
      chatKey: string;
      messageId: string;
      trust: "OWNER";
      text: string;
      promptMeta: PromptContextMeta;
    }
  | {
      version: 1;
      kind: "unmatched_command";
      chatKey: string;
      messageId: string;
      name: string;
      trust: string;
      respond: boolean;
    }
  | { version: 1; kind: "removed_command"; name: string }
  | { version: 1; kind: "record_only_chat" }
  | { version: 1; kind: "policy_rejected"; decision: unknown };

export type ChatInboxAdmission = {
  state: ChatInboxAdmissionState;
  stateIntegrity?: "valid" | "invalid";
  decision?: DurableChatAdmissionDecision;
  admissionHash?: string;
  decisionIntegrity?: "none" | "valid" | "invalid";
  submission?: FrozenChatTurnSubmission;
  submissionHash?: string;
  submissionIntegrity?: "none" | "valid" | "invalid";
  executionSessionFile?: string;
};

export type DurableChatAdmissionCommit = {
  state: Exclude<ChatInboxAdmissionState, "unclassified">;
  decision: DurableChatAdmissionDecision;
  submission?: FrozenChatTurnSubmission;
};

export type ResolvedDurableChatAdmission =
  | { kind: "unclassified" }
  | { kind: "record_only" }
  | {
      kind: "command";
      chatKey: string;
      messageId: string;
      command: { name: string; argsText: string };
      promptMeta: PromptContextMeta;
    }
  | {
      kind: "nerve_owner_message";
      chatKey: string;
      messageId: string;
      text: string;
      promptMeta: PromptContextMeta;
    }
  | {
      kind: "unmatched_command";
      chatKey: string;
      messageId: string;
      name: string;
      respond: boolean;
    }
  | { kind: "turn"; submission: FrozenChatTurnSubmission }
  | {
      kind: "unavailable";
      reason: "missing_frozen_submission" | "unsupported_admission";
    };

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function sameCanonicalIdentity(value: unknown, expected: string) {
  return (
    typeof value === "string" &&
    value === expected &&
    value === value.trim() &&
    expected === expected.trim()
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function optionalStringsAreValid(
  value: Record<string, unknown>,
  keys: string[],
) {
  return keys.every(
    (key) => value[key] === undefined || typeof value[key] === "string",
  );
}

function promptContextMetaIsValid(
  value: unknown,
  requiredChatKey: string,
  requiredIdentity?: string,
): value is PromptContextMeta {
  if (
    !isRecord(value) ||
    !optionalStringsAreValid(value, [
      "source",
      "chatKey",
      "chatName",
      "chatType",
      "userId",
      "nickname",
      "groupNickname",
      "identity",
      "taskId",
      "taskName",
    ]) ||
    !sameCanonicalIdentity(value.chatKey, requiredChatKey) ||
    (requiredIdentity !== undefined && value.identity !== requiredIdentity) ||
    (value.sentAt !== undefined &&
      (typeof value.sentAt !== "number" || !Number.isFinite(value.sentAt))) ||
    ["requiresMentionToStartTurn", "selfImproveEligible"].some(
      (key) => value[key] !== undefined && typeof value[key] !== "boolean",
    ) ||
    (value.taskContextKind !== undefined &&
      value.taskContextKind !== "scheduled-task") ||
    (value.frontend !== undefined &&
      value.frontend !== null &&
      (!isRecord(value.frontend) ||
        !optionalStringsAreValid(value.frontend, ["kind", "key"]))) ||
    (value.runtimeMetadata !== undefined && !isRecord(value.runtimeMetadata)) ||
    (value.attachedFiles !== undefined &&
      (!Array.isArray(value.attachedFiles) ||
        value.attachedFiles.some(
          (item) =>
            !isRecord(item) || !optionalStringsAreValid(item, ["name", "path"]),
        )))
  ) {
    return false;
  }
  return true;
}

export function durableAdmissionMatchesTurn(
  admission: DurableChatAdmissionCommit,
  turn: { chatKey: string; messageId: string },
) {
  if (admission.decision.version !== 1) return false;
  if (admission.state === "record_only") {
    if (admission.submission) return false;
    if (
      admission.decision.kind === "record_only_chat" ||
      admission.decision.kind === "policy_rejected"
    ) {
      return true;
    }
    return Boolean(
      admission.decision.kind === "removed_command" &&
      typeof admission.decision.name === "string" &&
      admission.decision.name &&
      admission.decision.name === admission.decision.name.trim(),
    );
  }
  if (admission.decision.kind === "message") {
    const submission = admission.submission;
    return Boolean(
      submission &&
      sameCanonicalIdentity(submission.chatKey, turn.chatKey) &&
      sameCanonicalIdentity(submission.incomingMessageId, turn.messageId) &&
      sameCanonicalIdentity(submission.promptMeta?.chatKey, turn.chatKey),
    );
  }
  if (admission.decision.kind === "command") {
    return Boolean(
      sameCanonicalIdentity(admission.decision.chatKey, turn.chatKey) &&
      sameCanonicalIdentity(admission.decision.messageId, turn.messageId) &&
      sameCanonicalIdentity(
        admission.decision.promptMeta?.chatKey,
        turn.chatKey,
      ) &&
      typeof admission.decision.trust === "string" &&
      admission.decision.trust === admission.decision.trust.trim() &&
      admission.decision.promptMeta?.identity === admission.decision.trust,
    );
  }
  if (admission.decision.kind === "nerve_owner_message") {
    return Boolean(
      sameCanonicalIdentity(admission.decision.chatKey, turn.chatKey) &&
      sameCanonicalIdentity(admission.decision.messageId, turn.messageId) &&
      admission.decision.trust === "OWNER" &&
      typeof admission.decision.text === "string" &&
      admission.decision.text.length > 0 &&
      sameCanonicalIdentity(
        admission.decision.promptMeta?.chatKey,
        turn.chatKey,
      ) &&
      admission.decision.promptMeta?.identity === "OWNER",
    );
  }
  if (admission.decision.kind === "unmatched_command") {
    return Boolean(
      sameCanonicalIdentity(admission.decision.chatKey, turn.chatKey) &&
      sameCanonicalIdentity(admission.decision.messageId, turn.messageId) &&
      typeof admission.decision.trust === "string" &&
      admission.decision.trust === admission.decision.trust.trim() &&
      admission.decision.trust.length > 0 &&
      typeof admission.decision.respond === "boolean",
    );
  }
  return false;
}

function currentPromptContextMeta(value: PromptContextMeta): PromptContextMeta {
  const meta = { ...value } as PromptContextMeta & Record<string, unknown>;
  delete meta.taskContextKind;
  delete meta.selfImproveEligible;
  return meta;
}

function frozenTurnSubmission(
  value: FrozenChatTurnSubmission | undefined,
): FrozenChatTurnSubmission | null {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !text(value.chatKey) ||
    !text(value.incomingMessageId) ||
    typeof value.text !== "string" ||
    !Array.isArray(value.attachments) ||
    (!text(value.text) && value.attachments.length === 0) ||
    !promptContextMetaIsValid(value.promptMeta, value.chatKey) ||
    !optionalStringsAreValid(value, [
      "replyToMessageId",
      "sessionFile",
      "model",
      "thinkingLevel",
      "receivedAt",
    ])
  ) {
    return null;
  }
  return { ...value, promptMeta: currentPromptContextMeta(value.promptMeta) };
}

export function resolveDurableChatAdmission(
  admission: ChatInboxAdmission,
  turn: { chatKey: string; messageId: string },
): ResolvedDurableChatAdmission {
  if (admission.state === "unclassified") {
    return admission.stateIntegrity !== "invalid" &&
      (!admission.decisionIntegrity ||
        admission.decisionIntegrity === "none") &&
      (!admission.submissionIntegrity ||
        admission.submissionIntegrity === "none") &&
      !admission.decision &&
      !admission.submission &&
      !admission.executionSessionFile
      ? { kind: "unclassified" }
      : { kind: "unavailable", reason: "unsupported_admission" };
  }

  const decision = admission.decision;
  if (admission.state === "record_only") {
    return admission.stateIntegrity !== "invalid" &&
      admission.decisionIntegrity === "valid" &&
      (!admission.submissionIntegrity ||
        admission.submissionIntegrity === "none") &&
      !admission.submission &&
      !admission.submissionHash &&
      decision &&
      durableAdmissionMatchesTurn(
        { state: "record_only", decision, submission: admission.submission },
        turn,
      )
      ? { kind: "record_only" }
      : { kind: "unavailable", reason: "unsupported_admission" };
  }

  if (
    admission.stateIntegrity === "invalid" ||
    admission.decisionIntegrity !== "valid" ||
    !decision ||
    !durableAdmissionMatchesTurn(
      {
        state: "actionable",
        decision,
        submission: admission.submission,
      },
      turn,
    )
  ) {
    return { kind: "unavailable", reason: "unsupported_admission" };
  }
  if (
    decision.kind !== "message" &&
    ((admission.submissionIntegrity &&
      admission.submissionIntegrity !== "none") ||
      admission.submission ||
      admission.submissionHash)
  ) {
    return { kind: "unavailable", reason: "unsupported_admission" };
  }
  if (decision.kind === "command") {
    if (
      !isRecord(decision.command) ||
      typeof decision.command.name !== "string" ||
      !decision.command.name ||
      decision.command.name !== decision.command.name.trim() ||
      typeof decision.command.argsText !== "string" ||
      decision.command.argsText !== decision.command.argsText.trim() ||
      typeof decision.trust !== "string" ||
      !decision.trust ||
      decision.trust !== decision.trust.trim() ||
      !promptContextMetaIsValid(
        decision.promptMeta,
        turn.chatKey,
        decision.trust,
      )
    ) {
      return { kind: "unavailable", reason: "unsupported_admission" };
    }
    return {
      kind: "command",
      chatKey: turn.chatKey,
      messageId: turn.messageId,
      command: {
        name: decision.command.name,
        argsText: decision.command.argsText,
      },
      promptMeta: currentPromptContextMeta(decision.promptMeta),
    };
  }
  if (decision.kind === "nerve_owner_message") {
    if (
      decision.trust !== "OWNER" ||
      typeof decision.text !== "string" ||
      !decision.text ||
      !promptContextMetaIsValid(decision.promptMeta, turn.chatKey, "OWNER")
    ) {
      return { kind: "unavailable", reason: "unsupported_admission" };
    }
    return {
      kind: "nerve_owner_message",
      chatKey: turn.chatKey,
      messageId: turn.messageId,
      text: decision.text,
      promptMeta: currentPromptContextMeta(decision.promptMeta),
    };
  }
  if (decision.kind === "unmatched_command") {
    const validName =
      typeof decision.name === "string" &&
      Boolean(decision.name) &&
      decision.name === decision.name.trim();
    return validName
      ? {
          kind: "unmatched_command",
          chatKey: turn.chatKey,
          messageId: turn.messageId,
          name: decision.name,
          respond: decision.respond,
        }
      : { kind: "unavailable", reason: "unsupported_admission" };
  }
  if (decision.kind === "message") {
    const submission =
      admission.submissionIntegrity === "valid"
        ? frozenTurnSubmission(admission.submission)
        : null;
    if (!submission) {
      return {
        kind: "unavailable",
        reason: "missing_frozen_submission",
      };
    }
    return {
      kind: "turn",
      submission: {
        ...submission,
        chatKey: turn.chatKey,
        incomingMessageId: turn.messageId,
        sessionFile:
          text(admission.executionSessionFile) || submission.sessionFile,
      },
    };
  }
  return { kind: "unavailable", reason: "unsupported_admission" };
}
