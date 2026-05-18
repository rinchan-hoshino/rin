import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  formatRuntimeErrorForUser,
  hasUserFacingRuntimeErrorMapping,
} from "../../src/core/rin-lib/user-facing-errors.js";

test("runtime error formatter keeps human messages", () => {
  assert.equal(formatRuntimeErrorForUser("fetch failed"), "fetch failed");
  assert.equal(
    formatRuntimeErrorForUser("prompt is too long"),
    "prompt is too long",
  );
});

test("runtime error formatter maps known internal markers to actionable messages", () => {
  assert.equal(
    formatRuntimeErrorForUser("new_session_session_file_unsupported"),
    "Could not start a new chat session because the command was bound to a replied message's old session. Retry /new; chat commands should not use replied-message sessions.",
  );
  assert.equal(
    formatRuntimeErrorForUser("frontend_model_not_found:openai/missing"),
    "Model not found: openai/missing. Choose an available model in /model or settings.",
  );
  assert.equal(
    formatRuntimeErrorForUser("rin_worker_exit"),
    "Rin's background worker exited before the request finished. Retry the action; if it repeats, restart Rin and try again.",
  );
  assert.equal(
    formatRuntimeErrorForUser("rin_no_attached_session"),
    "Rin could not find a session attached to this chat command. Start a new chat session with /new, then retry the command.",
  );
  assert.equal(
    formatRuntimeErrorForUser("rpc_turn_final_output_missing"),
    "Rin finished the turn but did not receive a final reply. Retry the action; if it repeats, restart Rin.",
  );
  assert.equal(
    formatRuntimeErrorForUser(
      "rin_daemon_unavailable: managed daemon service did not become available",
    ),
    "Rin's background service is not available: managed daemon service did not become available. Start or restart Rin, then retry.",
  );
});

test("runtime error formatter hides unmapped internal markers from user-facing text", () => {
  const text = formatRuntimeErrorForUser("some_new_internal_marker:debug_code");
  assert.equal(
    text,
    "Rin hit an internal runtime problem before it could finish. Retry the action; if it repeats, run rin doctor and check the logs.",
  );
  assert.equal(text.includes("some_new_internal_marker"), false);
  assert.equal(text.includes("debug_code"), false);

  const embedded = formatRuntimeErrorForUser(
    "Web search failed: google_challenge_required",
  );
  assert.match(embedded, /internal runtime problem|Google blocked/);
  assert.equal(embedded.includes("google_challenge_required"), false);

  const camel = formatRuntimeErrorForUser("invalid_chatKey:onebot/demo");
  assert.match(camel, /Invalid chat key/);
  assert.equal(camel.includes("invalid_chatKey"), false);
});

test("runtime error formatter does not leak Rin-owned marker literals", () => {
  const markerPattern = /\b[a-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/;
  const markers = collectRinOwnedErrorMarkers();
  assert.ok(markers.size > 0);
  for (const marker of markers) {
    assert.equal(hasUserFacingRuntimeErrorMapping(marker), true, marker);
    const formatted = formatRuntimeErrorForUser(marker);
    assert.equal(
      markerPattern.test(formatted),
      false,
      `${marker} formatted as ${formatted}`,
    );
  }
});

function collectRinOwnedErrorMarkers() {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const roots = ["src/app", "src/core"].map((item) =>
    path.join(repoRoot, item),
  );
  const files = roots.flatMap((root) => listFiles(root));
  const markers = new Set<string>();
  const markerLiteral =
    "([a-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+(?::[^\"'`\\s]*)?)";
  const patterns = [
    new RegExp(`throw\\s+new\\s+Error\\(\\s*["']${markerLiteral}["']`, "g"),
    new RegExp(`responseError\\([^)]*?["']${markerLiteral}["']`, "g"),
    new RegExp(`response\\([^)]*?false\\s*,\\s*["']${markerLiteral}["']`, "g"),
  ];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        markers.add(String(match[1]).split(":", 1)[0]);
      }
    }
  }
  return markers;
}

test("app entrypoints format caught errors before printing", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const entrypoints = [
    "src/app/rin/main.ts",
    "src/app/rin-tui/main.ts",
    "src/app/rin-install/main.ts",
    "src/app/rin-gui/main.ts",
    "src/app/rin-desktop-host/main.ts",
    "src/app/rin-daemon/daemon.ts",
    "src/app/rin-daemon/worker.ts",
    "src/core/rin-tui/main.ts",
  ];
  for (const relative of entrypoints) {
    const text = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.match(text, /formatRuntimeErrorForUser\(error \|\|/);
    assert.doesNotMatch(text, /console\.error\(String\(error\?\.message/);
  }
});

function listFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return listFiles(entryPath);
    if (entry.isFile() && entry.name.endsWith(".ts")) return [entryPath];
    return [];
  });
}
