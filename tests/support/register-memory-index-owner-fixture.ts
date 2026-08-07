import { register } from "node:module";

const transcriptsTarget = "dist/core/memory/transcripts.js";
const externalTarget = "dist/core/memory/external.js";

const transcriptsUrl = `data:text/javascript,${encodeURIComponent(`
export async function appendTranscriptArchiveEntry(input, agentDir) {
  globalThis.__rinMemoryOwnerEvents.push(["archive", input, agentDir]);
  if (globalThis.__rinMemoryOwnerArchiveFailure) throw new Error("archive owner failure");
}
export function extractTranscriptText(input) {
  const content = input?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((item) => String(item?.text || "")).join("").trim();
  return String(input?.text || "").trim();
}
export async function loadRecentTranscriptSessions(params, root) {
  globalThis.__rinMemoryOwnerEvents.push(["recent", params, root]);
  if (globalThis.__rinMemoryOwnerFailure === "recent") throw new Error("recent owner failure");
  return globalThis.__rinMemoryOwnerRecentResults || [];
}
export async function searchTranscriptArchive(query, params, root) {
  globalThis.__rinMemoryOwnerEvents.push(["search", query, params, root]);
  if (globalThis.__rinMemoryOwnerFailure === "search") throw new Error("search owner failure");
  return globalThis.__rinMemoryOwnerSearchResults || [];
}
export async function searchTranscriptArchiveAbortable(query, params, root, signal) {
  globalThis.__rinMemoryOwnerEvents.push(["search", query, params, root]);
  if (globalThis.__rinMemoryOwnerFailure === "search") throw new Error("search owner failure");
  if (!globalThis.__rinMemoryOwnerHoldSearch) return globalThis.__rinMemoryOwnerSearchResults || [];
  globalThis.__rinMemoryOwnerSearchStarted?.();
  return await new Promise((resolve, reject) => {
    const abort = () => reject(new Error("recall_aborted"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export async function loadRecentTranscriptSessionsAbortable(params, root, signal) {
  return await loadRecentTranscriptSessions(params, root, signal);
}
`)}`;

const externalUrl = `data:text/javascript,${encodeURIComponent(`
export async function searchExternalMemoryProviders(query, params) {
  globalThis.__rinMemoryOwnerEvents.push(["external", query, params]);
  if (globalThis.__rinMemoryOwnerFailure === "external") throw new Error("external owner failure");
  return globalThis.__rinMemoryOwnerExternalResults || [];
}
export async function writeExternalMemoryEntry(input) {
  globalThis.__rinMemoryOwnerEvents.push(["external-write", input]);
  if (globalThis.__rinMemoryOwnerExternalWriteFailure) throw new Error("external write failure");
}
`)}`;

const hookSource = `
const replacements = new Map([
  [${JSON.stringify(transcriptsTarget)}, ${JSON.stringify(transcriptsUrl)}],
  [${JSON.stringify(externalTarget)}, ${JSON.stringify(externalUrl)}],
]);
export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  for (const [target, url] of replacements) {
    if (resolved.url.endsWith(target)) return { url, shortCircuit: true };
  }
  return resolved;
}
`;

register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  import.meta.url,
);
globalThis.__rinMemoryOwnerEvents ||= [];
