export type MemoryExposure = "self_improve_prompts" | "self_improve_skills";
export type MemoryFidelity = "exact" | "fuzzy";
export type MemoryScope = "global" | "domain" | "project" | "session";
export type MemoryKind = "skill" | "instruction" | "rule" | "fact" | "index";

export type MemoryStatus = "active" | "superseded" | "invalidated";

export type MemoryDoc = {
  id: string;
  name: string;
  exposure: MemoryExposure;
  fidelity: MemoryFidelity;
  self_improve_prompt_slot: string;
  description: string;
  tags: string[];
  aliases: string[];
  scope: MemoryScope;
  kind: MemoryKind;
  sensitivity: string;
  source: string;
  updated_at: string;
  last_observed_at: string;
  observation_count: number;
  status: MemoryStatus;
  supersedes: string[];
  canonical: boolean;
  path: string;
  content: string;
};

export type MemoryEvent = {
  id: string;
  created_at: string;
  kind: "user_input" | "assistant_message" | "tool_result" | "system_note";
  session_id: string;
  session_file: string;
  chat_key: string;
  source: string;
  tool_name: string;
  is_error: boolean;
  summary: string;
  text: string;
  tags: string[];
};

export type MemoryRelationEdge = {
  from: string;
  to: string;
  score: number;
  reason: string;
};

export type MemoryRelationGraph = {
  updated_at: string;
  edges: MemoryRelationEdge[];
};

export const MEMORY_PROMPT_SLOTS = [
  "agent_profile",
  "user_profile",
  "core_doctrine",
] as const;

export const MEMORY_PROMPT_LIMITS: Record<
  string,
  { maxLines: number; fidelity: Array<MemoryFidelity> }
> = {
  agent_profile: { maxLines: 8, fidelity: ["exact", "fuzzy"] },
  user_profile: { maxLines: 4, fidelity: ["exact", "fuzzy"] },
  core_doctrine: { maxLines: 32, fidelity: ["fuzzy", "exact"] },
};

export const CHRONICLE_TAG = "chronicle";
export const EPISODE_TAG = "episode";
export const PROCESS_STATE_FILE = "process-state.json";
export const RELATIONS_STATE_FILE = "relations.json";
