import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

function describeTruncation(truncation: TruncationResult) {
  const byteLimit = formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES);
  const outputLines = truncation.outputLines;
  const totalLines = truncation.totalLines;
  if (truncation.firstLineExceedsLimit) {
    return {
      warning: `First line exceeds ${byteLimit} limit`,
      notice: `First line exceeds ${byteLimit} limit`,
    };
  }
  if (truncation.truncatedBy === "lines") {
    return {
      warning: `Truncated: showing ${outputLines} of ${totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)`,
      notice: `Showing ${outputLines} of ${totalLines} lines`,
    };
  }
  return {
    warning: `Truncated: ${outputLines} lines shown (${byteLimit} limit)`,
    notice: `Showing ${outputLines} of ${totalLines} lines (${byteLimit} limit)`,
  };
}

export function formatTruncationWarningMessage(truncation: TruncationResult) {
  return describeTruncation(truncation).warning;
}

export function formatTruncationNotice(truncation: TruncationResult) {
  return `[${describeTruncation(truncation).notice}.]`;
}

export function appendTruncationNotice(
  text: string,
  truncation: TruncationResult | undefined,
) {
  if (!truncation?.truncated) return text;
  const notice = formatTruncationNotice(truncation);
  return text ? `${text}\n\n${notice}` : notice;
}

type TruncateTextOptions = Parameters<typeof truncateHead>[1];

export function prepareTruncatedText(
  text: string,
  options?: TruncateTextOptions,
) {
  const result = truncateHead(text, options);
  const truncation = result.truncated ? result : undefined;
  return {
    outputText: appendTruncationNotice(result.content, truncation),
    previewText: result.content,
    truncation,
  };
}

export function prepareTruncatedAgentUserText(
  agentText: string,
  userText: string,
  options?: TruncateTextOptions,
) {
  const agent = prepareTruncatedText(agentText, options);
  if (agentText === userText) {
    return {
      ...agent,
      userPreviewText: agent.previewText,
      userTruncation: agent.truncation,
    };
  }

  const user = prepareTruncatedText(userText, options);
  return {
    ...agent,
    userPreviewText: user.previewText,
    userTruncation: user.truncation,
  };
}
