import {
  MemoryDoc,
  MemoryEvent,
  MEMORY_PROMPT_SLOTS,
  MemoryRelationGraph,
} from "./core/types.js";
import { safeString } from "./core/utils.js";

function promptLine(slot: string, body: string): string {
  const text = safeString(body).trim();
  if (!text) return "";
  return `[${slot}] ${text}`;
}

export function compileFromDocsAndEvents(
  docs: MemoryDoc[],
  _events: MemoryEvent[],
  _graph: MemoryRelationGraph,
  params: Record<string, any> = {},
  root = "",
) {
  const query = safeString(params.query || "").trim();
  const domainQuery = safeString(params.domainQuery || "").trim();
  const prompts = docs
    .filter(
      (doc) =>
        doc.exposure === "self_improve_prompts" &&
        doc.canonical &&
        MEMORY_PROMPT_SLOTS.includes(doc.self_improve_prompt_slot as any),
    )
    .sort(
      (a, b) =>
        MEMORY_PROMPT_SLOTS.indexOf(a.self_improve_prompt_slot as any) -
        MEMORY_PROMPT_SLOTS.indexOf(b.self_improve_prompt_slot as any),
    );

  return {
    root,
    query,
    domain_query: domainQuery,
    self_improve_prompt_slots: MEMORY_PROMPT_SLOTS,
    self_improve_prompt_context: prompts
      .map((doc) => promptLine(doc.self_improve_prompt_slot, doc.content))
      .filter(Boolean)
      .join("\n"),
    self_improve_prompt_prompt_docs: prompts.map((doc) => ({
      name: doc.name,
      self_improve_prompt_slot: doc.self_improve_prompt_slot,
      path: doc.path,
      content: safeString(doc.content).trim(),
    })),
    self_improve_skills: [],
    episode_docs: [],
    related_docs: [],
    history_events: [],
  };
}
