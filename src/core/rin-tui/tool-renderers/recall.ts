import { Text } from "@earendil-works/pi-tui";

import type { RecallToolDetails } from "../../rin-lib/core-tool-contracts.js";
import {
  buildUserFacingTextResult,
  formatHiddenResultsNotice,
  formatToolCallLine,
  formatToolDuration,
  renderTextToolResult,
} from "../../pi/render-utils.js";

type RecallRenderState = {
  startedAt?: number;
  endedAt?: number;
  interval?: NodeJS.Timeout;
};

export function formatRenderedRecallResult(
  result: any,
  options: any,
  theme: any,
  showImages: boolean,
  startedAt?: number,
  endedAt?: number,
) {
  const details = (result?.details as RecallToolDetails | undefined) || {};
  const topResultsNotice = formatHiddenResultsNotice(
    details.totalResults ?? 0,
    details.hiddenCount ?? 0,
  );
  const userResult = buildUserFacingTextResult(result, showImages, {
    userText: details.userText,
    details: {
      truncation: details.truncation,
      emptyMessage: details.emptyMessage,
      hiddenCount: details.hiddenCount,
      totalResults: details.totalResults,
    },
  });
  let text = renderTextToolResult(userResult, options, theme, showImages, {
    extraMutedLines: topResultsNotice ? [topResultsNotice] : [],
  });
  const duration = formatToolDuration(startedAt, endedAt);
  if (duration) {
    const durationText = theme.fg("muted", duration);
    text = text ? `${text}\n${durationText}` : `\n${durationText}`;
  }
  return text;
}

export function formatRecallCall(args: any, theme: any) {
  const query = String(args?.query || "").trim();
  return formatToolCallLine("recall", query || "recent", theme, {
    detailStyle: query ? "accent" : "muted",
  });
}

export const recallToolRenderer = {
  name: "recall",
  renderCall(args: any, theme: any, context: any) {
    const state = (context.state ||= {}) as RecallRenderState;
    if (context.executionStarted && state.startedAt === undefined) {
      state.startedAt = Date.now();
      state.endedAt = undefined;
    }
    const text =
      (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    text.setText(formatRecallCall(args, theme));
    return text;
  },
  renderResult(result: any, options: any, theme: any, context: any) {
    const state = (context.state ||= {}) as RecallRenderState;
    if (state.startedAt !== undefined && options.isPartial && !state.interval) {
      state.interval = setInterval(() => context.invalidate(), 1000);
    }
    if (!options.isPartial || context.isError) {
      state.endedAt ??= Date.now();
      if (state.interval) {
        clearInterval(state.interval);
        state.interval = undefined;
      }
    }

    const text =
      (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
    text.setText(
      formatRenderedRecallResult(
        result,
        options,
        theme,
        context.showImages,
        state.startedAt,
        state.endedAt,
      ),
    );
    return text;
  },
};
