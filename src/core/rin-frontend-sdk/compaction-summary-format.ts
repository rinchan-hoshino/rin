const DEFAULT_EXPAND_KEY_TEXT = "ctrl+o";
const DEFAULT_LINE_TEMPLATE =
  "Compacted from {tokens} tokens ({expandKey} to expand)";
const DEFAULT_TEXT_TEMPLATE = "[compaction]\n\n{summary}";

export type CompactionSummaryCollapsedTextOptions = {
  expandKeyText?: string;
  includeLabel?: boolean;
  lineTemplate?: string;
  textTemplate?: string;
};

function replaceTemplateValues(
  template: string,
  values: Record<string, string>,
) {
  return Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{${key}}`, value),
    template,
  );
}

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
  return replaceTemplateValues(
    String(options.lineTemplate || "").trim() || DEFAULT_LINE_TEMPLATE,
    { tokens: tokenText, expandKey: expandKeyText },
  );
}

export function formatCompactionSummaryCollapsedText(
  tokensBefore: unknown,
  options: CompactionSummaryCollapsedTextOptions = {},
) {
  const line = formatCompactionSummaryCollapsedLine(tokensBefore, options);
  if (!line) return "";
  if (options.includeLabel === false) return line;
  return replaceTemplateValues(
    String(options.textTemplate || "").trim() || DEFAULT_TEXT_TEMPLATE,
    { summary: line },
  );
}
