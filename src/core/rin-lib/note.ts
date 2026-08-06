/**
 * Rin core note capability.
 *
 * The model owns one scratch note per session branch. Snapshots live only in
 * Pi session custom entries, so compaction and branch reconstruction preserve
 * the note without turning it into cross-session memory.
 *
 * Read, write, and edit delegate to Pi's public tool factories over virtual
 * operations. Rin owns only the note action wrapper, session persistence, and
 * append behavior.
 */

import {
  createEditTool,
  createReadTool,
  createWriteTool,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { resolve as resolvePath } from "node:path";
import { Type } from "typebox";
import type {
  RinCapabilityContext,
  RinCapabilityDefinition,
} from "./capability-types.js";

export const RIN_NOTE_CUSTOM_ENTRY_TYPE = "rin.note";

const NOTE_VIRTUAL_CWD = process.cwd();
const NOTE_VIRTUAL_PATH = ".rin-session-note.txt";
const NOTE_MUTATION_QUEUE_PATH = resolvePath(
  NOTE_VIRTUAL_CWD,
  NOTE_VIRTUAL_PATH,
);

type NoteAction = "read" | "write" | "edit" | "append";

const NOTE_ACTIONS: readonly NoteAction[] = ["read", "write", "edit", "append"];

const NoteActionSchema = Type.Union(
  [
    Type.Literal("read"),
    Type.Literal("write"),
    Type.Literal("edit"),
    Type.Literal("append"),
  ],
  {
    description: "Operation to perform on the current session-branch note.",
  },
);

function getLineCount(content: string): number {
  return content === "" ? 0 : content.split("\n").length;
}

export function readLatestNoteContent(sessionManager: any): string {
  if (!sessionManager || typeof sessionManager.getBranch !== "function") {
    return "";
  }

  let branch: any[];
  try {
    branch = sessionManager.getBranch();
  } catch {
    return "";
  }
  if (!Array.isArray(branch)) return "";

  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (
      entry?.type === "custom" &&
      entry.customType === RIN_NOTE_CUSTOM_ENTRY_TYPE &&
      typeof entry.data?.content === "string"
    ) {
      return entry.data.content;
    }
  }
  return "";
}

export default function noteCapability(): RinCapabilityDefinition {
  let content = "";
  let activeSessionManager: any;

  const persist = (nextContent: string) => {
    const appendCustomEntry = activeSessionManager?.appendCustomEntry;
    if (typeof appendCustomEntry !== "function") {
      throw new Error("session custom entries are not available");
    }
    appendCustomEntry.call(activeSessionManager, RIN_NOTE_CUSTOM_ENTRY_TYPE, {
      content: nextContent,
    });
    content = nextContent;
  };

  const piReadTool: any = createReadTool(NOTE_VIRTUAL_CWD, {
    operations: {
      async access() {},
      async readFile() {
        return Buffer.from(content, "utf8");
      },
      async detectImageMimeType() {
        return undefined;
      },
    },
  });

  const piWriteTool: any = createWriteTool(NOTE_VIRTUAL_CWD, {
    operations: {
      async mkdir() {},
      async writeFile(_absolutePath, nextContent) {
        persist(nextContent);
      },
    },
  });

  const piEditTool: any = createEditTool(NOTE_VIRTUAL_CWD, {
    operations: {
      async access() {},
      async readFile() {
        return Buffer.from(content, "utf8");
      },
      async writeFile(_absolutePath, nextContent) {
        persist(nextContent);
      },
    },
  });

  const NoteParams: any = Type.Object({
    action: NoteActionSchema,
    offset: piReadTool.parameters.properties.offset,
    limit: piReadTool.parameters.properties.limit,
    content: Type.Optional(piWriteTool.parameters.properties.content),
    edits: Type.Optional(piEditTool.parameters.properties.edits),
  });

  const reconstructState = (ctx: RinCapabilityContext) => {
    activeSessionManager = ctx.sessionManager;
    content = readLatestNoteContent(activeSessionManager);
  };

  const noteToolDefinition: any = {
    name: "note",
    label: "note",
    description:
      "Maintain concise model-only factual continuity in the current session branch. It survives compaction. Store verified facts only; keep plans and pending actions in todo. Read uses Pi's optional offset and limit, write replaces the whole note, edit uses Pi's exact file-edit semantics, and append adds exact text.",
    promptSnippet:
      "Read or mutate factual continuity for the current session branch.",
    promptGuidelines: [
      "Use note only for concise, verified facts that must survive compaction; keep plans, pending actions, and checklists in todo.",
      "Use note read with Pi-native optional offset and limit. Use write for full replacement, edit for exact unique non-overlapping replacements, and append to add exact text at the end.",
    ],
    parameters: NoteParams,

    async execute(toolCallId, params: any, signal, onUpdate, executionContext) {
      const action = params?.action as NoteAction;
      if (!NOTE_ACTIONS.includes(action)) {
        throw new Error("invalid note action");
      }

      if (action === "read") {
        return piReadTool.execute(
          toolCallId,
          {
            path: NOTE_VIRTUAL_PATH,
            ...(params.offset === undefined ? {} : { offset: params.offset }),
            ...(params.limit === undefined ? {} : { limit: params.limit }),
          },
          signal,
          onUpdate,
          executionContext,
        );
      }

      if (action === "write") {
        if (typeof params.content !== "string") {
          throw new Error(
            "Write tool input is invalid. content must be a string.",
          );
        }
        return piWriteTool.execute(
          toolCallId,
          { path: NOTE_VIRTUAL_PATH, content: params.content },
          signal,
          onUpdate,
          executionContext,
        );
      }

      if (action === "edit") {
        return piEditTool.execute(
          toolCallId,
          { path: NOTE_VIRTUAL_PATH, edits: params.edits },
          signal,
          onUpdate,
          executionContext,
        );
      }

      if (typeof params.content !== "string") {
        throw new Error("append requires string content");
      }
      if (signal?.aborted) throw new Error("Operation aborted");
      await withFileMutationQueue(NOTE_MUTATION_QUEUE_PATH, async () => {
        if (signal?.aborted) throw new Error("Operation aborted");
        persist(content + params.content);
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Appended to note (${getLineCount(content)} lines total)`,
          },
        ],
        details: { action, lineCount: getLineCount(content) },
      };
    },
  };

  return {
    name: "note",
    tools: [noteToolDefinition],
    hooks: {
      session_start: [async (_event, ctx) => reconstructState(ctx)],
      session_tree: [async (_event, ctx) => reconstructState(ctx)],
    },
  };
}
