import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(import.meta.dirname, "../..");
const restrictedTools = await import(
  pathToFileURL(
    path.join(rootDir, "dist", "core", "self-improve", "restricted-tools.js"),
  ).href
);

async function withTempRoot(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rin-si-tools-"));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function toolByName(tools: any[], name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing ${name} tool`);
  return tool;
}

async function execute(tool: any, params: any) {
  return tool.execute("test-call", params, new AbortController().signal);
}

test("self-improve mutation tools only write inside the self-improve library", async () => {
  await withTempRoot(async (root) => {
    const agentDir = path.join(root, "agent");
    const libraryRoot = path.join(agentDir, "self_improve");
    const outsideRoot = path.join(root, "outside");
    await fs.mkdir(libraryRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    const tools = restrictedTools.createSelfImproveMutationTools(agentDir);
    const write = toolByName(tools, "write");
    const edit = toolByName(tools, "edit");
    const allowedFile = path.join(libraryRoot, "skills", "demo", "SKILL.md");

    await execute(write, { path: allowedFile, content: "before\n" });
    await execute(edit, {
      path: allowedFile,
      edits: [{ oldText: "before", newText: "after" }],
    });
    assert.equal(await fs.readFile(allowedFile, "utf8"), "after\n");

    await assert.rejects(
      () =>
        execute(write, {
          path: path.join(outsideRoot, "forbidden.txt"),
          content: "forbidden",
        }),
      /self_improve_mutation_outside_library/,
    );
    await assert.rejects(
      () =>
        execute(edit, {
          path: path.join(outsideRoot, "forbidden.txt"),
          edits: [{ oldText: "x", newText: "y" }],
        }),
      /self_improve_mutation_outside_library/,
    );
  });
});

test("self-improve mutation tools reject a symlinked library root", async () => {
  await withTempRoot(async (root) => {
    const agentDir = path.join(root, "agent");
    const outsideRoot = path.join(root, "outside");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.symlink(outsideRoot, path.join(agentDir, "self_improve"));
    const write = toolByName(
      restrictedTools.createSelfImproveMutationTools(agentDir),
      "write",
    );

    await assert.rejects(
      () =>
        execute(write, {
          path: path.join(agentDir, "self_improve", "forbidden.txt"),
          content: "forbidden",
        }),
      /self_improve_mutation_symlink_escape/,
    );
    await assert.rejects(
      () => fs.readFile(path.join(outsideRoot, "forbidden.txt"), "utf8"),
      /ENOENT/,
    );
  });
});

test("self-improve mutation tools reject symlink escapes", async () => {
  await withTempRoot(async (root) => {
    const agentDir = path.join(root, "agent");
    const libraryRoot = path.join(agentDir, "self_improve");
    const outsideRoot = path.join(root, "outside");
    await fs.mkdir(libraryRoot, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    await fs.symlink(outsideRoot, path.join(libraryRoot, "escape"));
    const write = toolByName(
      restrictedTools.createSelfImproveMutationTools(agentDir),
      "write",
    );

    await assert.rejects(
      () =>
        execute(write, {
          path: path.join(libraryRoot, "escape", "forbidden.txt"),
          content: "forbidden",
        }),
      /self_improve_mutation_symlink_escape/,
    );
    await assert.rejects(
      () => fs.readFile(path.join(outsideRoot, "forbidden.txt"), "utf8"),
      /ENOENT/,
    );
  });
});
