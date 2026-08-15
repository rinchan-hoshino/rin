import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const english = fs.readFileSync(path.join(rootDir, "README.md"), "utf8");

const translations = [
  {
    path: "readme/README.zh-CN.md",
    desktop: /\u684c\u9762\u5e94\u7528/u,
    surfaces: [/\u7ec8\u7aef/u, /\u81ea\u52a8\u5316/u, /\u804a\u5929/u],
    unconditionalPrerequisite:
      /\u6240\u6709\u5e73\u53f0\u4e0a\u90fd\u9700\u8981/u,
    bundle: /Linux x64[\s\S]*\u5e73\u53f0 bundle/u,
    fallback: /\u56de\u9000\u5230\u6e90\u7801/u,
  },
  {
    path: "readme/README.ja.md",
    desktop: /\u30c7\u30b9\u30af\u30c8\u30c3\u30d7/u,
    surfaces: [
      /\u30bf\u30fc\u30df\u30ca\u30eb/u,
      /\u81ea\u52d5\u5316/u,
      /\u30c1\u30e3\u30c3\u30c8/u,
    ],
    unconditionalPrerequisite:
      /\u3059\u3079\u3066\u306e\u30d7\u30e9\u30c3\u30c8\u30d5\u30a9\u30fc\u30e0\u3067/u,
    bundle:
      /Linux x64[\s\S]*\u30d7\u30e9\u30c3\u30c8\u30d5\u30a9\u30fc\u30e0 bundle/u,
    fallback:
      /\u30bd\u30fc\u30b9\u306b\u30d5\u30a9\u30fc\u30eb\u30d0\u30c3\u30af/u,
  },
  {
    path: "readme/README.es.md",
    desktop: /escritorio/i,
    surfaces: [/terminal/i, /automatización/i, /chat/i],
    unconditionalPrerequisite: /en todas las plataformas/i,
    bundle: /Linux x64[\s\S]*bundle de plataforma/i,
    fallback: /ruta de código fuente/i,
  },
  {
    path: "readme/README.fr.md",
    desktop: /bureau/i,
    surfaces: [/terminal/i, /automatisation/i, /chat/i],
    unconditionalPrerequisite: /sur toutes les plateformes/i,
    bundle: /Linux x64[\s\S]*bundle de plateforme/i,
    fallback: /repli vers les sources/i,
  },
].map((entry) => ({
  ...entry,
  content: fs.readFileSync(path.join(rootDir, entry.path), "utf8"),
}));

function installRoutes(content: string) {
  return [
    ...content.matchAll(
      /https:\/\/raw\.githubusercontent\.com\/rinchan-hoshino\/rin\/(main|bootstrap)\/install\.(sh|ps1)/g,
    ),
  ]
    .map((match) => `${match[1]}/install.${match[2]}`)
    .sort();
}

function productIntroduction(content: string) {
  return content.slice(content.indexOf("# Rin"), content.indexOf("|"));
}

function installationPrerequisites(content: string) {
  const start = content.indexOf("Linux x64");
  return content.slice(start, content.indexOf("\n### ", start));
}

test("public README translations preserve the canonical product surfaces and install routes", () => {
  const canonicalRoutes = installRoutes(english);
  assert.ok(canonicalRoutes.includes("bootstrap/install.sh"));
  assert.ok(canonicalRoutes.includes("main/install.sh"));

  for (const translation of translations) {
    const intro = productIntroduction(translation.content);
    assert.doesNotMatch(intro, translation.desktop, translation.path);
    for (const surface of translation.surfaces) {
      assert.match(intro, surface, translation.path);
    }
    assert.deepEqual(
      installRoutes(translation.content),
      canonicalRoutes,
      translation.path,
    );
  }
});

test("public installation guidance distinguishes bundled runtime from source prerequisites", () => {
  assert.match(english, /Linux x64[\s\S]*matching platform bundle/);
  assert.match(english, /source fallback/);
  assert.doesNotMatch(english, /npm on every platform/);

  for (const translation of translations) {
    const prerequisites = installationPrerequisites(translation.content);
    assert.match(prerequisites, translation.bundle, translation.path);
    assert.match(prerequisites, translation.fallback, translation.path);
    assert.doesNotMatch(
      prerequisites,
      translation.unconditionalPrerequisite,
      translation.path,
    );
    assert.match(translation.content, /Node\.js 22\.19\.0/);
    assert.match(translation.content, /node -v[\s\S]*npm -v/);
    assert.match(translation.content, /winget upgrade OpenJS\.NodeJS\.LTS/);
  }
});
