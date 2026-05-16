import { safeString } from "../text-utils.js";

export function formatReportTime(value: unknown) {
  const text = safeString(value).trim();
  if (!text) return "-";
  const timestamp = Date.parse(text);
  if (Number.isNaN(timestamp)) return text;
  return new Date(timestamp).toLocaleString();
}

function pad(value: string, width: number) {
  if (value.length >= width) return value;
  return `${value}${" ".repeat(width - value.length)}`;
}

function truncate(value: string, width: number) {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

export function renderReportTable(
  rows: Array<Record<string, unknown>>,
  columns: string[],
  options: {
    emptyText?: string;
    indent?: string;
    maxColumnWidth?: number;
  } = {},
) {
  const indent = options.indent ?? "";
  if (!rows.length) return `${indent}${options.emptyText ?? "(no rows)"}`;

  const maxColumnWidth = options.maxColumnWidth ?? 48;
  const widths = new Map<string, number>();
  for (const column of columns) widths.set(column, column.length);
  for (const row of rows) {
    for (const column of columns) {
      const value = safeString(row[column] ?? "");
      widths.set(
        column,
        Math.min(
          maxColumnWidth,
          Math.max(widths.get(column) || 0, value.length),
        ),
      );
    }
  }

  const header = columns
    .map((column) => pad(column, widths.get(column) || column.length))
    .join("  ");
  const divider = columns
    .map((column) => "-".repeat(widths.get(column) || column.length))
    .join("  ");
  const body = rows.map((row) =>
    columns
      .map((column) => {
        const width = widths.get(column) || column.length;
        return pad(truncate(safeString(row[column] ?? ""), width), width);
      })
      .join("  "),
  );
  return [header, divider, ...body]
    .map((line) => `${indent}${line}`)
    .join("\n");
}
