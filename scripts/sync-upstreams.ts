import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageJsonPath = path.join(repoRoot, "package.json");
const preferredTempRoot = [process.env.TMPDIR, os.tmpdir()]
  .map((value) => String(value || "").trim())
  .find(Boolean);

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeVersion(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?/);
  return match ? match[0] : raw;
}

const optionValueNames = new Set(["ref", "repo", "sourceSubdir"]);

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) {
      positional.push(current);
      continue;
    }
    const key = current.slice(2);
    const next = argv[i + 1];
    if (optionValueNames.has(key)) {
      if (!next || next.startsWith("--")) {
        throw new Error(`Missing value for --${key}`);
      }
      options[key] = next;
      i += 1;
      continue;
    }
    if (!next || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    i += 1;
  }
  return { positional, options };
}

function runGit(args, cwd, stdio = ["ignore", "pipe", "inherit"]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio,
  }).trim();
}

function replacePath(sourcePath, destPath) {
  fs.rmSync(destPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.cpSync(sourcePath, destPath, { recursive: true });
}

function preserveRinSkillCreatorPromptContract(destRoot) {
  const skillPath = path.join(destRoot, "SKILL.md");
  const optimizerPath = path.join(
    destRoot,
    "scripts",
    "improve_description.py",
  );
  if (fs.existsSync(skillPath)) {
    let skill = fs.readFileSync(skillPath, "utf8");
    skill = skill
      .replace(
        /^description:.*$/m,
        'description: "Use when creating, changing, evaluating, benchmarking, packaging, or optimizing the trigger accuracy of a skill."',
      )
      .replace(
        /- \*\*description\*\*:.*$/m,
        "- **description**: Concise trigger conditions only. State when the skill should and should not be consulted; keep capabilities, outcomes, procedures, and examples in the body or references. This is the primary routing mechanism, so use realistic intent language and include only decision-changing near-miss boundaries.",
      );
    fs.writeFileSync(skillPath, skill, "utf8");
  }

  if (fs.existsSync(optimizerPath)) {
    let optimizer = fs.readFileSync(optimizerPath, "utf8");
    optimizer = optimizer.replace(
      /Concretely, your description should not be more than about 100-200 words,[\s\S]*?- If you're getting lots of failures after repeated attempts, change things up\. Try different sentence structures or wordings\./,
      `Concretely, keep the description under 180 characters. It contains concise trigger conditions only: when the skill should or should not be consulted. Do not summarize capabilities, outcomes, procedures, examples, or implementation details; those belong in the skill body or references.

Here are some tips that we've found to work well in writing these descriptions:
- Phrase the route as "Use when ..." and name the user's intent or situation.
- Include only decision-changing near-miss exclusions.
- Make the trigger distinctive enough to compete with adjacent skills.
- If repeated attempts fail, change the trigger categories or boundaries rather than adding behavior summaries.`,
    );
    fs.writeFileSync(optimizerPath, optimizer, "utf8");
  }
}

const packageJson = readJson(packageJsonPath, {});
const piPackageVersion = normalizeVersion(
  packageJson?.dependencies?.["@earendil-works/pi-coding-agent"],
);
if (!piPackageVersion) {
  throw new Error(
    "Unable to determine @earendil-works/pi-coding-agent version from package.json",
  );
}

const mirrors = {
  pi: {
    repo: "https://github.com/badlogic/pi-mono.git",
    sourceSubdir: "packages/coding-agent",
    defaultRef: `v${piPackageVersion}`,
    destRoot: path.join(repoRoot, "upstream", "pi"),
    packageName: "@earendil-works/pi-coding-agent",
    packageVersion: piPackageVersion,
    paths: ["README.md", "CHANGELOG.md", "docs", "examples"],
  },
  "skill-creator": {
    repo: "https://github.com/anthropics/skills.git",
    sourceSubdir: "skills/skill-creator",
    defaultRef: "main",
    destRoot: path.join(repoRoot, "upstream", "skill-creator"),
    paths: null,
  },
};

function resolveMirrorRef(mirror, existingMeta, options = {}) {
  const explicitRef = String(options.ref || "").trim();
  if (explicitRef) return explicitRef;

  const defaultRef = String(mirror.defaultRef || "").trim();
  const existingRef = String(existingMeta.ref || "").trim();
  if (!defaultRef) return existingRef;
  if (!mirror.packageVersion) return existingRef || defaultRef;

  const existingPackageVersion = String(
    existingMeta.packageVersion || "",
  ).trim();
  if (existingPackageVersion === mirror.packageVersion && existingRef) {
    return existingRef;
  }

  return defaultRef;
}

function syncMirror(name, options = {}) {
  const mirror = mirrors[name];
  if (!mirror) throw new Error(`Unknown upstream mirror: ${name}`);

  const upstreamMetaPath = path.join(mirror.destRoot, "_upstream.json");
  const existingMeta = readJson(upstreamMetaPath, {});
  const repo = String(options.repo || existingMeta.repo || mirror.repo).trim();
  const sourceSubdir = String(
    options.sourceSubdir || existingMeta.sourceSubdir || mirror.sourceSubdir,
  ).trim();
  const ref = resolveMirrorRef(mirror, existingMeta, options);
  const tempRoot = fs.mkdtempSync(
    path.join(preferredTempRoot, `rin-sync-${name}-`),
  );
  const cloneDir = path.join(tempRoot, "upstream");

  try {
    execFileSync(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--branch",
        ref,
        "--filter=blob:none",
        "--sparse",
        repo,
        cloneDir,
      ],
      { stdio: "inherit" },
    );
    execFileSync("git", ["sparse-checkout", "set", sourceSubdir], {
      cwd: cloneDir,
      stdio: "inherit",
    });

    const resolvedCommit = runGit(["rev-parse", "HEAD"], cloneDir);
    if (Array.isArray(mirror.paths)) {
      fs.mkdirSync(mirror.destRoot, { recursive: true });
      for (const relativePath of mirror.paths) {
        replacePath(
          path.join(cloneDir, sourceSubdir, relativePath),
          path.join(mirror.destRoot, relativePath),
        );
      }
    } else {
      replacePath(path.join(cloneDir, sourceSubdir), mirror.destRoot);
    }
    if (name === "skill-creator") {
      preserveRinSkillCreatorPromptContract(mirror.destRoot);
    }

    const nextMeta = {
      repo,
      sourceSubdir,
      ref,
      resolvedCommit,
      syncedAt: new Date().toISOString(),
      syncMethod: "git sparse-checkout",
    };
    if (mirror.packageName) nextMeta.packageName = mirror.packageName;
    if (mirror.packageVersion) nextMeta.packageVersion = mirror.packageVersion;
    if (Array.isArray(mirror.paths)) nextMeta.paths = mirror.paths;
    fs.writeFileSync(
      upstreamMetaPath,
      `${JSON.stringify(nextMeta, null, 2)}\n`,
      "utf8",
    );

    process.stdout.write(
      [
        `Synced ${name} from ${repo}`,
        `ref=${ref}`,
        `commit=${resolvedCommit}`,
        `dest=${mirror.destRoot}`,
      ].join("\n") + "\n",
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const { positional, options } = parseArgs(process.argv.slice(2));
const targets = positional.length ? positional : Object.keys(mirrors);
for (const target of targets) {
  syncMirror(target, options);
}
