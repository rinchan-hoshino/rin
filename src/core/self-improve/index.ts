import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "../rin-lib/capability-types.js";
import { existsSync } from "fs";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import {
  enqueueMemoryMaintenanceJob,
  enqueueSessionSummaryJob,
  spawnQueuedMemoryWorker,
} from "./async-jobs.js";
import {
  executeSelfImproveTool,
  formatSelfImproveAgentResult,
  formatSelfImproveResult,
  markOnboardingPrompted,
  resolveAgentDir,
} from "./lib.js";
import {
  describeSelfImprovePromptSlot,
  refineSelfImprovePromptSlot,
} from "./processing.js";
import { readSessionMetadata } from "../session/metadata.js";

const SELF_IMPROVE_REVIEW_INTERVAL = 8;
const reviewStateBySession = new Map<
  string,
  { userTurns: number; lastQueuedTurn: number }
>();

const sessionMeta = readSessionMetadata;

function shouldSkipAutomaticMaintenance(sessionFile: string) {
  return !existsSync(sessionFile);
}

function getSessionReviewState(sessionId: string) {
  const key = String(sessionId || "").trim();
  if (!key) return null;
  const current = reviewStateBySession.get(key) || {
    userTurns: 0,
    lastQueuedTurn: 0,
  };
  reviewStateBySession.set(key, current);
  return current;
}

function triggerInitConversation(
  options: Pick<RinCapabilityOptions, "sendMessage">,
  _mode: "auto" | "manual",
  busy: boolean,
) {
  options.sendMessage(
    {
      customType: "self-improve-init-trigger",
      content: "The user is requesting initialization.",
      display: false,
    },
    busy ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: true },
  );
}

async function processSelfImproveReview(
  ctx: any,
  opts: {
    sessionFile?: string;
    leafId?: string;
    trigger: string;
    snapshotKey?: string;
  },
) {
  const sessionFile = String(opts.sessionFile || "").trim();
  const agentDir = String(ctx?.agentDir || "").trim();
  if (!sessionFile || !agentDir) {
    return;
  }
  if (shouldSkipAutomaticMaintenance(sessionFile)) {
    return;
  }
  const meta = readSessionMetadata(opts);
  await enqueueMemoryMaintenanceJob({
    agentDir,
    sessionFile,
    leafId: meta.leafId || undefined,
    trigger: opts.trigger,
    snapshotKey: opts.snapshotKey,
  });
  spawnQueuedMemoryWorker(agentDir);
}

async function processSessionSummaryUpdate(
  ctx: any,
  opts: { sessionFile?: string; leafId?: string; trigger: string },
) {
  const sessionFile = String(opts.sessionFile || "").trim();
  const agentDir = String(ctx?.agentDir || "").trim();
  if (!sessionFile || !agentDir) {
    return;
  }
  if (shouldSkipAutomaticMaintenance(sessionFile)) {
    return;
  }
  const meta = readSessionMetadata(opts);
  await enqueueSessionSummaryJob({
    agentDir,
    sessionFile,
    leafId: meta.leafId || undefined,
    trigger: opts.trigger,
  });
  spawnQueuedMemoryWorker(agentDir);
}

function stripPathFromDoc(doc: any) {
  if (!doc || typeof doc !== "object") return doc;
  const { path: _path, ...rest } = doc;
  return rest;
}

function stripSavePromptPaths(response: any) {
  if (!response || typeof response !== "object") return response;
  const { path: _path, doc, ...rest } = response;
  return {
    name: "self-improve",
    ...rest,
    ...(doc ? { doc: stripPathFromDoc(doc) } : {}),
  };
}

const saveSelfImprovePromptParams = Type.Object({
  slot: Type.Union(
    [
      Type.Literal("agent_profile"),
      Type.Literal("user_profile"),
      Type.Literal("core_doctrine"),
      Type.Literal("core_facts"),
    ],
    {
      description:
        "Which always-on prompt slot to inspect or update. `agent_profile` stores the assistant's stable role, tone, behavior style, and the user's standing expectations for how the assistant should generally respond. `user_profile` stores the user's identity knowledge. `core_doctrine` stores durable methodology, worldview, and values. `core_facts` stores durable external facts, environment facts, user preferences, and operating conventions.",
    },
  ),
  content: Type.Optional(
    Type.String({
      description:
        "Full revised canonical content for the slot. This is a whole-slot replacement, not an append-only patch. Rewrite the slot into its best current compact form by revising, polishing, compressing, merging, moving, or deleting existing lines as needed, and move content to a more appropriate slot or skill when it no longer belongs here. Use one line per topic. Keep each line concise and information-dense. Omit this on the first call to read the current slot state.",
    }),
  ),
  baseContent: Type.Optional(
    Type.String({
      description:
        "Current canonical content returned by the read step. Before updating a populated slot, first call `save_prompts` with only `slot` and no `content` to read the current content, then pass that exact content here as `baseContent`. `content` does not need to use it as its basis.",
    }),
  ),
});

async function executeSaveSelfImprovePromptAction(params: any) {
  try {
    const slot = String(params?.slot || "").trim();
    const existing = await executeSelfImproveTool({ action: "compile" });
    const currentDoc = Array.isArray(existing?.self_improve_prompt_prompt_docs)
      ? existing.self_improve_prompt_prompt_docs.find(
          (doc: any) =>
            String(doc?.self_improve_prompt_slot || "").trim() === slot,
        )
      : null;
    const currentState = describeSelfImprovePromptSlot({
      slot,
      existingContent: String(currentDoc?.content || ""),
    });

    const usageLine = `usage=${currentState.currentLines}/${currentState.maxLines} lines`;
    const baseContent = String(params?.baseContent || "").trim();
    const incomingContent = String(params?.content || "").trim();

    if (!incomingContent) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Loaded save_prompts slot: ${currentState.slot}`,
              usageLine,
              currentState.content || "(empty)",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: {
          ok: true,
          status: "review_required",
          slot: currentState.slot,
          usage: `${currentState.currentLines}/${currentState.maxLines} lines`,
          currentContent: currentState.content,
        },
      };
    }

    if (currentState.content && !baseContent) {
      throw new Error("self_improve_base_content_required");
    }

    if (baseContent !== currentState.content) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Stale save_prompts baseContent for slot: ${currentState.slot}`,
              usageLine,
              currentState.content || "(empty)",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        details: {
          ok: false,
          status: "stale_base_content",
          slot: currentState.slot,
          usage: `${currentState.currentLines}/${currentState.maxLines} lines`,
          currentContent: currentState.content,
        },
        isError: true,
      };
    }

    const refined = refineSelfImprovePromptSlot({
      slot: currentState.slot,
      incomingContent,
    });
    const response = await executeSelfImproveTool({
      action: "save_self_improve_prompt",
      selfImprovePromptSlot: currentState.slot,
      name: refined.name,
      content: refined.content,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Updated save_prompts slot: ${currentState.slot}`,
            `usage=${refined.nextLines}/${refined.maxLines} lines`,
            refined.content || "(empty)",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
      details: {
        ...stripSavePromptPaths(response),
        ok: true,
        status: "updated",
        slot: currentState.slot,
        usage: `${refined.nextLines}/${refined.maxLines} lines`,
      },
    };
  } catch (error: any) {
    const message = String(
      error?.message || error || "self_improve_prompt_action_failed",
    );
    const slot = String(params?.slot || "").trim();
    let usage = "0/0";
    try {
      if (slot) {
        const existing = await executeSelfImproveTool({ action: "compile" });
        const currentDoc = Array.isArray(
          existing?.self_improve_prompt_prompt_docs,
        )
          ? existing.self_improve_prompt_prompt_docs.find(
              (doc: any) =>
                String(doc?.self_improve_prompt_slot || "").trim() === slot,
            )
          : null;
        const currentState = describeSelfImprovePromptSlot({
          slot,
          existingContent: String(currentDoc?.content || ""),
        });
        usage = `${currentState.currentLines}/${currentState.maxLines} lines`;
      }
    } catch {}
    return {
      content: [{ type: "text" as const, text: message }],
      details: {
        ok: false,
        error: message,
        usage,
        agentText: slot
          ? `save_prompts failed for slot: ${slot}\nusage=${usage}\n${message}`
          : `save_prompts failed\n${message}`,
        userText: slot
          ? `save_prompts failed for slot: ${slot}\nusage=${usage}\n${message}`
          : `save_prompts failed\n${message}`,
      },
      isError: true,
    };
  }
}

function renderSelfImproveResult(
  result: any,
  _options: any,
  theme: any,
  context: any,
) {
  const output = result.content
    ?.filter((c: any) => c?.type === "text")
    .map((c: any) => c?.text || "")
    .join("\n");
  if (!output) return new Text("", 0, 0);
  const text =
    (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  text.setText(
    `\n${context.isError ? theme.fg("error", output) : theme.fg("toolOutput", output)}`,
  );
  return text;
}

export default function selfImproveModule(
  options: RinCapabilityOptions,
): RinCapabilityDefinition {
  return {
    tools: [
      {
        name: "save_prompts",
        label: "Save Prompts",
        description:
          "Save durable prompt baselines that persist across sessions and stay available every turn. Keep them compact and focused on what will still matter later.",
        promptSnippet: "Save durable prompt baselines.",
        promptGuidelines: [
          "Use save_prompts when a durable baseline about the assistant, the user, durable methods and values, or durable facts and operating conventions should remain available by default in future turns rather than only for session-local progress or one-off task state.",
        ],
        parameters: saveSelfImprovePromptParams,
        execute: async (_toolCallId, params) =>
          await executeSaveSelfImprovePromptAction(params),
        renderResult: renderSelfImproveResult,
      },
    ],
    hooks: {
      message_end: [
        async (event, ctx) => {
          const role = String(event?.message?.role || "").trim();
          const meta = sessionMeta(ctx);
          const state = getSessionReviewState(meta.sessionId);
          if (!state || !meta.sessionFile || !meta.sessionPersisted) return;

          if (role === "user") {
            state.userTurns += 1;
            return;
          }

          if (
            role === "assistant" &&
            state.userTurns > 0 &&
            state.userTurns - state.lastQueuedTurn >=
              SELF_IMPROVE_REVIEW_INTERVAL
          ) {
            await processSelfImproveReview(ctx, {
              sessionFile: meta.sessionFile,
              leafId: meta.leafId,
              trigger: "self_improve:periodic_review",
              snapshotKey: `review:${state.userTurns}`,
            });
            state.lastQueuedTurn = state.userTurns;
          }
        },
      ],
      session_before_compact: [
        async (_event, ctx) => {
          const meta = sessionMeta(ctx);
          if (!meta.sessionFile || !meta.sessionPersisted) return;
          await processSelfImproveReview(ctx, {
            sessionFile: meta.sessionFile,
            leafId: meta.leafId,
            trigger: "self_improve:session_compaction_review",
            snapshotKey: `compact:${meta.leafId || meta.sessionFile}`,
          });
        },
      ],
      session_shutdown: [
        async (_event, ctx) => {
          const meta = sessionMeta(ctx);
          if (!meta.sessionPersisted) {
            if (meta.sessionId) reviewStateBySession.delete(meta.sessionId);
            return;
          }
          await processSelfImproveReview(ctx, {
            sessionFile: meta.sessionFile,
            leafId: meta.leafId,
            trigger: "self_improve:session_shutdown_review",
          });
          await processSessionSummaryUpdate(ctx, {
            sessionFile: meta.sessionFile,
            leafId: meta.leafId,
            trigger: "session_summary:session_shutdown",
          });
          if (meta.sessionId) reviewStateBySession.delete(meta.sessionId);
        },
      ],
    },
    commands: [
      {
        name: "init",
        description: "Start or restart self-improve onboarding conversation.",
        handler: async (_args, ctx) => {
          await markOnboardingPrompted(resolveAgentDir, "manual:/init");
          ctx.ui.notify(
            ctx.isIdle()
              ? "Self-improve onboarding started."
              : "Self-improve onboarding queued.",
            "info",
          );
          triggerInitConversation(options, "manual", !ctx.isIdle());
        },
      },
    ],
  };
}
