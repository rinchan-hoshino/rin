import { asArray } from "../json-utils.js";

export type ReportSection = {
  lines: string[];
};

export function renderReportSection(section: ReportSection): string {
  return asArray(section.lines)
    .map((line) => String(line || "").trimEnd())
    .filter(Boolean)
    .join("\n");
}
