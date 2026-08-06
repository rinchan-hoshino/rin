import { register } from "node:module";

const target = "dist/core/rin/usage.js";
const sources: Record<string, string> = {
  "dist/core/rin/shared.js": `
    export function safeString(value) { return value == null ? "" : String(value); }
    export function extractSubcommandArgv(argv, subcommand) { const index = argv.indexOf(subcommand); return index >= 0 ? argv.slice(index + 1) : argv; }
    export function createTargetExecutionContext(parsed) { globalThis.__rinUsageOwnerEvents.push(["context", parsed]); return globalThis.__rinUsageOwnerScenario.context; }
    export function captureInternalRinCommand(context, command, argv, subcommand) { globalThis.__rinUsageOwnerEvents.push(["forward", context, command, argv, subcommand]); return globalThis.__rinUsageOwnerScenario.forwarded ?? "forwarded"; }
    export class ParsedArgs {}
  `,
  "dist/core/rin-lib/agent-runtime.js": `
    export async function loadRinAgentRuntime() { globalThis.__rinUsageOwnerEvents.push(["runtime"]); if (globalThis.__rinUsageOwnerScenario.runtimeError) throw globalThis.__rinUsageOwnerScenario.runtimeError; return globalThis.__rinUsageOwnerScenario.runtime; }
  `,
  "dist/core/time-utils.js": `export function nowIso() { return globalThis.__rinUsageOwnerScenario.nowIso || "2026-07-18T01:02:03.000Z"; }`,
  "dist/core/http/transport.js": `
    export function createRinHttpTransport() {
      return {
        fetch: (url, options) => globalThis.fetch(url, options),
        async close() {},
      };
    }
    export async function discardRinHttpResponseBody() {}
  `,
  "dist/core/rin/report-format.js": `
    export function formatReportTime(value) { return value ? "TIME:" + value : "-"; }
    export function renderReportTable(rows, columns) { globalThis.__rinUsageOwnerEvents.push(["table", rows, columns]); return JSON.stringify({ rows, columns }); }
  `,
  "dist/core/token-usage/store.js": `
    export function formatProviderModelLabel(provider, model) { return [provider, model].filter(Boolean).join("/") || "(none)"; }
    export function getTokenUsageOverview(options) { globalThis.__rinUsageOwnerEvents.push(["overview", options]); return globalThis.__rinUsageOwnerScenario.overview || {}; }
    export function listTokenUsageDimensions() { return globalThis.__rinUsageOwnerScenario.dimensions || ["session", "provider_model"]; }
    export function queryTokenUsageAggregate(options) { globalThis.__rinUsageOwnerEvents.push(["aggregate", options]); return globalThis.__rinUsageOwnerScenario.aggregateRows || []; }
    export function queryTokenUsageEvents(options) { globalThis.__rinUsageOwnerEvents.push(["events", options]); return globalThis.__rinUsageOwnerScenario.eventRows || []; }
  `,
  "dist/core/rin/usage-chart.js": `
    export function buildUsageTrendSeries(agentDir) { globalThis.__rinUsageOwnerEvents.push(["series", agentDir]); return globalThis.__rinUsageOwnerScenario.series || { buckets: [] }; }
    export function renderUsageTrendTextChart(series) { globalThis.__rinUsageOwnerEvents.push(["text-chart", series]); return "OWNER TREND"; }
    export function writeUsageTrendChartImage(agentDir, options) { globalThis.__rinUsageOwnerEvents.push(["image", agentDir, options]); return globalThis.__rinUsageOwnerScenario.imagePath || "/tmp/owner-usage.png"; }
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

(globalThis as any).__rinUsageOwnerEvents ||= [];
(globalThis as any).__rinUsageOwnerScenario ||= {};
