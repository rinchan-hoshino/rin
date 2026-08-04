import fs from "node:fs/promises";
import path from "node:path";

import {
  createEditTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

function isOutsideRoot(root: string, target: string) {
  const relative = path.relative(root, target);
  return (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

async function assertSelfImproveMutationPath(
  libraryRoot: string,
  targetPath: string,
) {
  const rootStat = await fs.lstat(libraryRoot);
  if (rootStat.isSymbolicLink()) {
    throw new Error(`self_improve_mutation_symlink_escape:${libraryRoot}`);
  }
  const absoluteTarget = path.resolve(targetPath);
  if (isOutsideRoot(libraryRoot, absoluteTarget)) {
    throw new Error(`self_improve_mutation_outside_library:${absoluteTarget}`);
  }

  const relative = path.relative(libraryRoot, absoluteTarget);
  let current = libraryRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`self_improve_mutation_symlink_escape:${current}`);
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
  return absoluteTarget;
}

function asToolDefinition(tool: any) {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters,
    execute(
      toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: any,
    ) {
      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}

export function createSelfImproveMutationTools(agentDir: string) {
  const libraryRoot = path.resolve(agentDir, "self_improve");
  const write = createWriteTool(libraryRoot, {
    operations: {
      async mkdir(dir: string) {
        await assertSelfImproveMutationPath(libraryRoot, dir);
        await fs.mkdir(dir, { recursive: true });
      },
      async writeFile(filePath: string, content: string) {
        await assertSelfImproveMutationPath(libraryRoot, filePath);
        await fs.writeFile(filePath, content);
      },
    },
  });
  const edit = createEditTool(libraryRoot, {
    operations: {
      async readFile(filePath: string) {
        await assertSelfImproveMutationPath(libraryRoot, filePath);
        return await fs.readFile(filePath);
      },
      async writeFile(filePath: string, content: string) {
        await assertSelfImproveMutationPath(libraryRoot, filePath);
        await fs.writeFile(filePath, content);
      },
      async access(filePath: string) {
        await assertSelfImproveMutationPath(libraryRoot, filePath);
        await fs.access(filePath);
      },
    },
  });
  return [asToolDefinition(write), asToolDefinition(edit)];
}
