import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const rootDir = path.resolve(import.meta.dirname, "../..");
const read = (relative: string) =>
  fs.readFileSync(path.join(rootDir, relative), "utf8");

function listTypeScriptFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name);
    return entry.isDirectory()
      ? listTypeScriptFiles(fullPath)
      : entry.isFile() && entry.name.endsWith(".ts")
        ? [fullPath]
        : [];
  });
}

test("Chat owns its outbox contract, validation, and persistence dependency direction", () => {
  const legacyPath = path.join(rootDir, "src/core/rin-lib/chat-outbox.ts");
  const contractPath = "src/core/rin-lib/chat-outbox-contract.ts";
  const outboxPath = "src/core/chat/outbox.ts";

  assert.equal(fs.existsSync(legacyPath), false);
  assert.equal(fs.existsSync(path.join(rootDir, contractPath)), true);
  assert.equal(fs.existsSync(path.join(rootDir, outboxPath)), true);

  const contract = read(contractPath);
  assert.doesNotMatch(contract, /^import\b/m);

  const validation = read("src/core/chat/outbox-payload-validation.ts");
  assert.match(validation, /from "\.\.\/rin-lib\/chat-outbox-contract\.js"/);
  assert.doesNotMatch(validation, /rin-lib\/chat-outbox\.js/);

  const outbox = read(outboxPath);
  assert.match(outbox, /from "\.\/database\.js"/);
  assert.match(outbox, /from "\.\/outbox-payload-validation\.js"/);
  assert.match(outbox, /from "\.\.\/rin-lib\/chat-outbox-contract\.js"/);

  for (const filePath of listTypeScriptFiles(path.join(rootDir, "src"))) {
    assert.doesNotMatch(
      fs.readFileSync(filePath, "utf8"),
      /rin-lib\/chat-outbox\.js/,
      path.relative(rootDir, filePath),
    );
  }
});
