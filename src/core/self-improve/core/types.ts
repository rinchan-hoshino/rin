export type SelfImproveExposure =
  | "self_improve_prompts"
  | "self_improve_skills";
export type SelfImproveFidelity = "exact" | "fuzzy";
export type SelfImproveScope = "global" | "domain" | "project" | "session";
export type SelfImproveKind =
  | "skill"
  | "instruction"
  | "rule"
  | "fact"
  | "index";

export type SelfImproveStatus = "active" | "superseded" | "invalidated";

export type SelfImproveDoc = {
  id: string;
  name: string;
  exposure: SelfImproveExposure;
  fidelity: SelfImproveFidelity;
  self_improve_prompt_slot: string;
  description: string;
  tags: string[];
  aliases: string[];
  scope: SelfImproveScope;
  kind: SelfImproveKind;
  sensitivity: string;
  source: string;
  updated_at: string;
  last_observed_at: string;
  observation_count: number;
  status: SelfImproveStatus;
  supersedes: string[];
  canonical: boolean;
  path: string;
  content: string;
};

export type SelfImproveEvent = {
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

export type SelfImproveRelationEdge = {
  from: string;
  to: string;
  score: number;
  reason: string;
};

export type SelfImproveRelationGraph = {
  updated_at: string;
  edges: SelfImproveRelationEdge[];
};

export const SELF_IMPROVE_PROMPT_SLOTS = [
  "agent_profile",
  "user_profile",
  "core_doctrine",
] as const;

export const SELF_IMPROVE_PROMPT_LIMITS: Record<
  string,
  { maxLines: number; fidelity: Array<SelfImproveFidelity> }
> = {
  agent_profile: { maxLines: 8, fidelity: ["exact", "fuzzy"] },
  user_profile: { maxLines: 4, fidelity: ["exact", "fuzzy"] },
  core_doctrine: { maxLines: 32, fidelity: ["fuzzy", "exact"] },
};

export const CHRONICLE_TAG = "chronicle";
export const EPISODE_TAG = "episode";
export const PROCESS_STATE_FILE = "process-state.json";
export const RELATIONS_STATE_FILE = "relations.json";
