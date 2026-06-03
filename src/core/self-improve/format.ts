import { asArray } from "../json-utils.js";

function toSentenceCaseLabel(text: string) {
  const parts = String(text || "")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  if (!parts.length) return "";
  parts[0] = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  return parts.join(" ");
}

function trimText(value: unknown) {
  return String(value || "").trim();
}

function collectPromptDocs(result: any) {
  return asArray<any>(result?.self_improve_prompt_prompt_docs);
}

function getPromptDocBody(doc: any) {
  return trimText(doc?.content || doc?.preview);
}

function getPromptDocLabel(doc: any) {
  return toSentenceCaseLabel(
    trimText(doc?.self_improve_prompt_slot || doc?.id || doc?.name),
  );
}

function getPromptDocPath(doc: any) {
  return trimText(doc?.path);
}

function buildPromptBlock(
  result: any,
  options: { includeSystemPrefaces?: boolean } = {},
): string {
  const lines: string[] = [];
  for (const doc of collectPromptDocs(result)) {
    const body = getPromptDocBody(doc);
    const label = getPromptDocLabel(doc);
    if (!body || !label) continue;
    lines.push(`${label}:`);
    if (options.includeSystemPrefaces) {
      const slot = trimText(doc?.self_improve_prompt_slot);
      if (slot === "agent_profile") {
        lines.push(
          "Use this agent profile as the standing role, voice, and response-style contract.",
        );
      }
      if (slot === "core_doctrine") {
        lines.push(
          "Follow this core doctrine as the standing methodology and decision contract.",
        );
      }
    }
    lines.push(body);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function normalizeResultRows(response: any) {
  return asArray<any>(response?.results);
}

function formatMetaParts(parts: unknown[], separator: string) {
  return parts
    .map((part) => trimText(part))
    .filter(Boolean)
    .join(separator);
}

function formatTags(tags: unknown) {
  return asArray(tags)
    .map((tag) => trimText(tag))
    .filter(Boolean)
    .join(",");
}

function getItemName(item: any) {
  return trimText(item?.name || item?.id) || "(untitled)";
}

function formatListRowText(item: any, index: number, compact: boolean) {
  const exposure = trimText(item?.exposure);
  const scope = trimText(item?.scope);
  const kind = trimText(item?.kind);
  const slot = trimText(item?.self_improve_prompt_slot);
  const itemPath = getPromptDocPath(item);
  const tags = formatTags(item?.tags);
  const metaParts = compact
    ? [
        exposure,
        scope,
        kind,
        slot ? `slot=${slot}` : "",
        itemPath ? `path=${itemPath}` : "",
      ]
    : [
        exposure ? `[${exposure}]` : "",
        scope ? `scope=${scope}` : "",
        kind ? `kind=${kind}` : "",
        slot ? `slot=${slot}` : "",
        tags ? `tags=${tags}` : "",
        itemPath ? `path=${itemPath}` : "",
      ];
  const meta = formatMetaParts(metaParts, compact ? " | " : " ");
  return compact
    ? `${index + 1}. ${getItemName(item)}${meta ? ` | ${meta}` : ""}`
    : `- ${getItemName(item)}${meta ? ` ${meta}` : ""}`;
}

function formatSearchRowText(item: any, index: number, compact: boolean) {
  const meta = compact
    ? formatMetaParts(
        [
          `score=${Number(item?.score || 0).toFixed(2)}`,
          trimText(item?.exposure),
          trimText(item?.scope),
          getPromptDocPath(item) ? `path=${getPromptDocPath(item)}` : "",
        ],
        " | ",
      )
    : formatMetaParts(
        [
          `score=${Number(item?.score || 0).toFixed(2)}`,
          trimText(item?.exposure),
          trimText(item?.scope),
        ],
        " • ",
      );
  const summary = trimText(item?.description);
  if (compact) {
    return `${index + 1}. ${getItemName(item)}${meta ? ` | ${meta}` : ""}`;
  }
  return [
    `${index + 1}. ${getItemName(item)}${meta ? ` — ${meta}` : ""}`,
    getPromptDocPath(item),
    summary,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCompiledSelfImprovePrompt(result: any): string {
  return buildPromptBlock(result);
}

export function buildSystemPromptSelfImprove(result: any): string {
  return buildPromptBlock(result, { includeSystemPrefaces: true });
}

function formatCompileAgentDocPaths(response: any): string[] {
  return collectPromptDocs(response)
    .map((doc: any, index: number) => {
      const docPath = getPromptDocPath(doc);
      return docPath
        ? `self_improve_prompts[${index + 1}] path=${docPath}`
        : "";
    })
    .filter(Boolean);
}

function formatSavedPromptResult(doc: any, compact: boolean): string {
  return compact
    ? "self_improve save_self_improve_prompt"
    : `Saved self-improve prompt: ${getItemName(doc)}`;
}

function formatSelfImproveActionResult(
  action: string,
  response: any,
  compact: boolean,
): string {
  const normalizedAction = trimText(action);
  const rows = normalizeResultRows(response);
  const query = trimText(response?.query);

  if (action === "list") {
    if (!rows.length) {
      return compact ? "self_improve list 0" : "No self-improve prompts found.";
    }
    return [
      compact
        ? `self_improve list ${rows.length}`
        : `Self-improve prompts (${rows.length}):`,
      ...rows.map((item: any, index: number) =>
        formatListRowText(item, index, compact),
      ),
    ].join("\n");
  }

  if (action === "search") {
    if (!rows.length) {
      return compact
        ? `self_improve search ${query} (0)`
        : `No self-improve matches for: ${query}`;
    }
    return [
      compact
        ? `self_improve search ${query} (${rows.length})`
        : `Self-improve matches for: ${query}`,
      ...rows.map((item: any, index: number) =>
        formatSearchRowText(item, index, compact),
      ),
    ].join(compact ? "\n" : "\n\n");
  }

  if (action === "save_self_improve_prompt") {
    return formatSavedPromptResult(response?.doc, compact);
  }

  if (action === "compile") {
    if (!compact) {
      return (
        buildCompiledSelfImprovePrompt(response) ||
        "No compiled self-improve prompt available."
      );
    }
    const docs = formatCompileAgentDocPaths(response);
    return [
      `self_improve compile ${query || "(no query)"}`,
      `self_improve_prompts: ${docs.length}`,
      ...docs,
    ].join("\n");
  }

  return compact
    ? `self_improve ${normalizedAction || "result"}`
    : `Self-improve action completed: ${normalizedAction || "unknown"}`;
}

export function formatSelfImproveResult(action: string, response: any): string {
  return formatSelfImproveActionResult(action, response, false);
}

export function formatSelfImproveAgentResult(
  action: string,
  response: any,
): string {
  return formatSelfImproveActionResult(action, response, true);
}
