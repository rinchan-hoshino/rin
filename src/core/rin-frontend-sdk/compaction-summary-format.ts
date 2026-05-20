const DEFAULT_EXPAND_KEY_TEXT = "ctrl+o";

export type CompactionSummaryCollapsedTextOptions = {
  expandKeyText?: string;
  includeLabel?: boolean;
};

export function formatCompactionTokenCount(tokensBefore: unknown) {
  const value = Number(tokensBefore);
  if (!Number.isFinite(value) || value <= 0) return "";
  return Math.trunc(value).toLocaleString();
}

export function formatCompactionSummaryCollapsedLine(
  tokensBefore: unknown,
  options: CompactionSummaryCollapsedTextOptions = {},
) {
  const tokenText = formatCompactionTokenCount(tokensBefore);
  if (!tokenText) return "";
  const expandKeyText =
    String(options.expandKeyText || "").trim() || DEFAULT_EXPAND_KEY_TEXT;
  return `Compacted from ${tokenText} tokens (${expandKeyText} to expand)`;
}

export function formatCompactionSummaryCollapsedText(
  tokensBefore: unknown,
  options: CompactionSummaryCollapsedTextOptions = {},
) {
  const line = formatCompactionSummaryCollapsedLine(tokensBefore, options);
  if (!line) return "";
  return options.includeLabel === false ? line : `[compaction]\n\n${line}`;
}
