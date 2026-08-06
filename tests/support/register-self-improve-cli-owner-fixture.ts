import { register } from "node:module";

const target = "dist/core/rin/self-improve.js";
const sources: Record<string, string> = {
  "dist/core/rin/shared.js": `
    export function safeString(value) { return value == null ? "" : String(value); }
    export function extractSubcommandArgv(argv, command) { const index = argv.indexOf(command); return index < 0 ? [...argv] : argv.slice(index + 1); }
    export function createTargetExecutionContext(parsed) { globalThis.__rinSelfImproveEvents.push(["context", parsed]); return globalThis.__rinSelfImproveContext; }
    export function captureInternalRinCommand(context, marker, argv, command) { const args = extractSubcommandArgv(argv, command); globalThis.__rinSelfImproveEvents.push(["capture", marker, args]); return context.capture([process.execPath, context.repoRoot + "/dist/app/rin/main.js", marker, ...args]); }
  `,
  "dist/core/self-improve/paths.js": `
    import path from "node:path";
    export function maintenanceHistoryPath(agentDir) { return agentDir ? path.join(agentDir, "maintenance-history.jsonl") : ""; }
  `,
  "dist/core/time-utils.js": `export function nowIso() { return "2026-07-17T12:34:56.000Z"; }`,
  "dist/core/rin/report-format.js": `
    export function formatReportTime(value) { return value ? "time:" + String(value) : "-"; }
    export function renderReportTable(rows, columns, options) { globalThis.__rinSelfImproveEvents.push(["table", rows, columns, options]); return rows.length ? rows.map((row) => columns.map((column) => row[column] ?? "").join("|")).join("\\n") : options.emptyText; }
  `,
  "dist/core/rin/interactive-list.js": `
    export async function runInteractiveList(options) { globalThis.__rinSelfImproveEvents.push(["interactive", options.intervalMs]); const rendered = await options.render({ selectedIndex: 0, expanded: false }); globalThis.__rinSelfImproveEvents.push(["interactive-render", rendered.itemCount, rendered.content]); return globalThis.__rinSelfImproveInteractiveOpened; }
  `,
};
const urls = Object.fromEntries(
  Object.entries(sources).map(([key, source]) => [
    key,
    `data:text/javascript,${encodeURIComponent(source)}`,
  ]),
);
const hook = `
const target=${JSON.stringify(target)};const urls=${JSON.stringify(urls)};
export async function resolve(specifier,context,nextResolve){
 const resolved=await nextResolve(specifier,context);
 if(context.parentURL?.endsWith(target)) for(const [key,url] of Object.entries(urls)) if(resolved.url.endsWith(key)) return {url,shortCircuit:true};
 return resolved;
}`;
register(`data:text/javascript,${encodeURIComponent(hook)}`, import.meta.url);

(globalThis as any).__rinSelfImproveEvents ||= [];
(globalThis as any).__rinSelfImproveInteractiveOpened = true;
(globalThis as any).__rinSelfImproveContext ||= {
  isTargetUser: true,
  installDir: "/owner/install",
  repoRoot: "/owner/repo",
  exec(argv: string[]) {
    (globalThis as any).__rinSelfImproveEvents.push(["exec", argv]);
  },
  capture(argv: string[]) {
    (globalThis as any).__rinSelfImproveEvents.push(["context-capture", argv]);
    return "owner-forwarded";
  },
};
