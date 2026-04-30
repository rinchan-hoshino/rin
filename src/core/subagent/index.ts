import type {
  RinCapabilityDefinition,
  RinCapabilityOptions,
} from "../rin-lib/capability-types.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { StringEnum } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";

import {
  applySubagentTaskPreferences,
  executeSubagentRun,
  getSubagentBackendInfo,
} from "./service.js";
import { getDefaultSubagentSessionDir } from "./session-utils.js";
import type {
  ProviderModelSummary,
  RunSubagentParams,
  SubagentBackendInfo,
  SubagentSessionMode,
  TaskResult,
} from "./types.js";
import {
  buildSubagentAgentText,
  buildSubagentUserText,
  summarizeTaskResult,
} from "./format-utils.js";
import { VALID_SUBAGENT_THINKING_LEVELS as VALID_THINKING_LEVELS } from "./model-utils.js";
import {
  type TruncationResult,
  truncateHead,
} from "@mariozechner/pi-coding-agent";
import {
  appendTruncationNotice,
  buildUserFacingTextResult,
  ExpandableTextResultComponent,
  formatToolCallLine,
  getToolResultUserText,
  prepareTruncatedText,
  rebuildExpandableTextResultComponent,
  renderTextToolResult,
} from "../pi/render-utils.js";

const VALID_SESSION_MODES = ["memory", "persist", "resume", "fork"] as const;
const createLooseEnumSchema = (...args: Parameters<typeof StringEnum>) =>
  StringEnum(...args) as any;

const ThinkingLevelSchema = createLooseEnumSchema(
  VALID_THINKING_LEVELS as ThinkingLevel[],
  {
    description: "Thinking level: off, minimal, low, medium, high, xhigh.",
  },
);

const SessionModeSchema = createLooseEnumSchema(
  [...VALID_SESSION_MODES] as SubagentSessionMode[],
  {
    description:
      "Worker session mode: memory for ephemeral context, persist for a new saved session, resume to continue a saved session, fork to branch from a saved session. Fork sessions persist by default; set session.keep to false to make a fork ephemeral.",
  },
);

const SessionSchema = Type.Optional(
  Type.Object({
    mode: Type.Optional(SessionModeSchema),
    sessionFile: Type.Optional(
      Type.String({
        description: `Worker sessionFile path relative to agentDir, for example sessions/managed/subagent/demo.jsonl. Required for session.mode resume or fork. If you need to discover one, inspect ${getDefaultSubagentSessionDir()} with bash/find/rg.`,
      }),
    ),
    name: Type.Optional(
      Type.String({
        description:
          "Optional display name for the worker session. Useful for new persisted sessions and renaming resumed or forked sessions.",
      }),
    ),
    keep: Type.Optional(
      Type.Boolean({
        description:
          "When session.mode is `fork`, controls whether the forked worker session is kept for later resume. Defaults to true; set false to use an ephemeral in-memory fork.",
      }),
    ),
  }),
);

const DisabledExtensionsSchema = Type.Optional(
  Type.Array(
    Type.String({
      description:
        "Rin capability name to hide from the worker runtime, for example `memory`.",
    }),
    {
      description:
        "Optional Rin capability names to hide from the worker runtime.",
    },
  ),
);

const RunParamsSchema = Type.Object({
  prompt: Type.Optional(Type.String({ description: "Prompt for the worker." })),
  model: Type.Optional(
    Type.String({
      description:
        "Exact model id in provider/model form. Use list_models to inspect the currently available models first.",
    }),
  ),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  session: SessionSchema,
  disabledExtensions: DisabledExtensionsSchema,
});

type SubagentDetails = {
  action: "run" | "list_models";
  backend: "in-process-session";
  currentModel?: string;
  currentThinkingLevel: ThinkingLevel;
  providers: ProviderModelSummary[];
  results?: TaskResult[];
  agentText?: string;
  userText?: string;
  fullOutputPath?: string;
  truncated?: boolean;
  truncation?: TruncationResult;
};

type SubagentRenderState = {
  startedAt: number | undefined;
  endedAt: number | undefined;
  interval: NodeJS.Timeout | undefined;
};

const SUBAGENT_PREVIEW_LINES = 5;

function formatModelList(
  details: SubagentDetails | SubagentBackendInfo,
): string {
  const lines: string[] = [];
  lines.push(`backend=${details.backend}`);
  lines.push(`currentModel=${details.currentModel ?? "(not set)"}`);
  lines.push(`currentThinkingLevel=${details.currentThinkingLevel}`);
  lines.push("");
  if (!details.providers.length) {
    lines.push("No available models found. Configure API keys first.");
    return lines.join("\n");
  }
  for (const provider of details.providers) {
    lines.push(
      `${provider.provider}: ${provider.top3.join(", ") || "(none)"}${provider.count > 3 ? ` (+${provider.count - 3} more)` : ""}`,
    );
  }
  return lines.join("\n");
}

async function writeSubagentFullOutput(agentText: string, userText: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "rin-subagent-"));
  const filePath = path.join(dir, "subagent.txt");
  await writeFile(
    filePath,
    ["## Agent text", agentText, "", "## User text", userText].join("\n"),
    "utf8",
  );
  return filePath;
}

function buildRunUpdate(
  results: TaskResult[],
  detailsBase: SubagentBackendInfo,
) {
  const current = results[0];
  const lines = [
    `Subagent: ${current?.status || "pending"}`,
    "",
    ...results.map(summarizeTaskResult),
  ];
  return {
    name: "subagent",
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      ...detailsBase,
      action: "run" as const,
      results: results.map((result) => ({ ...result })),
    },
  };
}

async function listModelsResult(ctx: any, currentThinkingLevel: ThinkingLevel) {
  const detailsBase = await getSubagentBackendInfo(ctx, currentThinkingLevel);
  const text = formatModelList(detailsBase);
  const truncated = prepareTruncatedText(text);
  return {
    content: [{ type: "text" as const, text: truncated.outputText }],
    details: {
      ...detailsBase,
      action: "list_models" as const,
      userText: truncated.previewText,
      truncation: truncated.truncation,
    },
  };
}

async function runSubagentResult(
  params: RunSubagentParams,
  signal: AbortSignal | undefined,
  onUpdate: any,
  ctx: any,
  currentThinkingLevel: ThinkingLevel,
) {
  const run = await executeSubagentRun({
    params,
    signal,
    ctx,
    currentThinkingLevel,
    onProgress(results, details) {
      onUpdate?.(buildRunUpdate(results, details));
    },
  });

  const detailsBase: SubagentDetails = {
    action: "run",
    backend: run.backend,
    currentModel: run.currentModel,
    currentThinkingLevel: run.currentThinkingLevel,
    providers: run.providers,
  };

  if (run.ok === false) {
    const text = run.error.startsWith("Unknown or unavailable model:")
      ? `${run.error}\n\n${formatModelList(detailsBase)}`
      : run.error;
    return {
      content: [{ type: "text" as const, text }],
      details: detailsBase,
      isError: true,
    };
  }

  const failed = run.results.filter((result) => result.exitCode !== 0);
  const agentText = buildSubagentAgentText(run.results);
  const userText = buildSubagentUserText(run.results);
  const agentTruncation = truncateHead(agentText);
  const userTruncation = truncateHead(userText);
  const truncated = agentTruncation.truncated || userTruncation.truncated;
  const fullOutputPath = truncated
    ? await writeSubagentFullOutput(agentText, userText)
    : undefined;
  const details: SubagentDetails = {
    ...detailsBase,
    results: run.results,
    agentText: agentTruncation.content,
    userText: userTruncation.content,
    fullOutputPath,
    truncated,
    truncation: userTruncation.truncated
      ? userTruncation
      : agentTruncation.truncated
        ? agentTruncation
        : undefined,
  };

  return {
    content: [{ type: "text" as const, text: agentTruncation.content }],
    details,
    isError: failed.length > 0,
  };
}

export { applySubagentTaskPreferences };

export default function subagentModule(
  options: RinCapabilityOptions,
): RinCapabilityDefinition {
  return {
    tools: [
      {
        name: "run_subagent",
        label: "Run Subagent",
        description:
          "Run a worker with independent context and optional model selection.",
        promptSnippet: "Run a worker with independent context.",
        promptGuidelines: [
          "Use run_subagent to run a worker with independent context and optional model selection.",
          "Always use run_subagent for simple independent work that does not depend on the current conversation context.",
          "Use run_subagent when the user asks for a subagent or wants a different model.",
        ],
        parameters: RunParamsSchema,
        async execute(_toolCallId, rawParams, signal, onUpdate, ctx) {
          return await runSubagentResult(
            rawParams as RunSubagentParams,
            signal,
            onUpdate,
            ctx,
            options.getThinkingLevel(),
          );
        },
        renderCall(args, theme, context) {
          const state = context.state as SubagentRenderState;
          if (context.executionStarted && state.startedAt === undefined) {
            state.startedAt = Date.now();
            state.endedAt = undefined;
          }
          const text =
            (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
          const preview = String(args.prompt || "")
            .replace(/\s+/g, " ")
            .trim();
          text.setText(
            formatToolCallLine("run_subagent", preview || "...", theme),
          );
          return text;
        },
        renderResult(result, options, theme, context) {
          const state = context.state as SubagentRenderState;
          if (
            state.startedAt !== undefined &&
            options.isPartial &&
            !state.interval
          ) {
            state.interval = setInterval(() => context.invalidate(), 1000);
          }
          if (!options.isPartial || context.isError) {
            state.endedAt ??= Date.now();
            if (state.interval) {
              clearInterval(state.interval);
              state.interval = undefined;
            }
          }

          const details = result.details as SubagentDetails | undefined;
          const outputText = getToolResultUserText(
            result,
            context.showImages,
            details?.userText,
          );
          const component =
            (context.lastComponent as
              | ExpandableTextResultComponent
              | undefined) ?? new ExpandableTextResultComponent();
          rebuildExpandableTextResultComponent(
            component,
            {
              outputText,
              expanded: options.expanded,
              previewLines: SUBAGENT_PREVIEW_LINES,
              fullOutputPath: details?.fullOutputPath,
              truncation: details?.truncation,
              startedAt: state.startedAt,
              endedAt: state.endedAt,
            },
            theme,
          );
          component.invalidate();
          return component;
        },
      },
      {
        name: "list_models",
        label: "List Models",
        description: "List available models.",
        promptSnippet: "List available models.",
        promptGuidelines: [],
        parameters: Type.Object({}),
        async execute(_toolCallId, _rawParams, _signal, _onUpdate, ctx) {
          return await listModelsResult(ctx, options.getThinkingLevel());
        },
        renderCall(_args, theme) {
          return new Text(formatToolCallLine("list_models", "", theme), 0, 0);
        },
        renderResult(result: any, options, theme, context) {
          const details = result.details as SubagentDetails | undefined;
          const userResult = buildUserFacingTextResult(
            result,
            context.showImages,
            {
              userText: details?.userText,
              details: {
                truncation: details?.truncation,
              },
            },
          );
          return new Text(
            renderTextToolResult(
              userResult,
              options,
              theme,
              context.showImages,
            ),
            0,
            0,
          );
        },
      },
    ],
  };
}
