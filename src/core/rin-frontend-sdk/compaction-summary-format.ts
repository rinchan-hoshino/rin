const DEFAULT_TITLE_TEMPLATE = "Compacted from {tokens} tokens";
const DEFAULT_EXPAND_HINT_TEMPLATE = "({expandKey} to expand)";
const DEFAULT_COLLAPSED_WRAPPER_TEMPLATE = "[compaction]\n\n{summary}";

export type CompactionSummaryCollapsedTextOptions = {
  expandHintText?: string | false | null;
  expandHintTemplate?: string;
  expandKeyText?: string;
  includeLabel?: boolean;
  lineTemplate?: string;
  textTemplate?: string;
  titleTemplate?: string;
  wrapperTemplate?: string;
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

export function formatCompactionSummaryTitle(
  tokensBefore: unknown,
  options: Pick<
    CompactionSummaryCollapsedTextOptions,
    "lineTemplate" | "titleTemplate"
  > = {},
) {
  const tokenText = formatCompactionTokenCount(tokensBefore);
  if (!tokenText) return "";
  return replaceTemplateValues(
    String(options.titleTemplate || options.lineTemplate || "").trim() ||
      DEFAULT_TITLE_TEMPLATE,
    { tokens: tokenText },
  );
}

export function formatCompactionExpandHint(
  options: Pick<
    CompactionSummaryCollapsedTextOptions,
    "expandHintTemplate" | "expandHintText" | "expandKeyText"
  > = {},
) {
  if (options.expandHintText === false || options.expandHintText === null) {
    return "";
  }
  const explicitHint = String(options.expandHintText || "").trim();
  if (explicitHint) return explicitHint;
  const expandKeyText = String(options.expandKeyText || "").trim();
  if (!expandKeyText) return "";
  return replaceTemplateValues(
    String(options.expandHintTemplate || "").trim() ||
      DEFAULT_EXPAND_HINT_TEMPLATE,
    { expandKey: expandKeyText },
  );
}

export function formatCompactionSummaryCollapsedLine(
  tokensBefore: unknown,
  options: CompactionSummaryCollapsedTextOptions = {},
) {
  const title = formatCompactionSummaryTitle(tokensBefore, options);
  if (!title) return "";
  const hint = formatCompactionExpandHint(options);
  return hint ? `${title} ${hint}` : title;
}

export function formatCompactionSummaryCollapsedText(
  tokensBefore: unknown,
  options: CompactionSummaryCollapsedTextOptions = {},
) {
  const summary = formatCompactionSummaryCollapsedLine(tokensBefore, options);
  if (!summary) return "";
  const wrapperTemplate =
    options.includeLabel === false
      ? "{summary}"
      : String(options.wrapperTemplate || options.textTemplate || "").trim() ||
        DEFAULT_COLLAPSED_WRAPPER_TEMPLATE;
  return replaceTemplateValues(wrapperTemplate, { summary });
}
