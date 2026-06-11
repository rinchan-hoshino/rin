import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  formatRuntimeErrorForChat,
  formatRuntimeErrorForTui,
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

test("tui error formatter keeps terse Pi-style errors", () => {
  assert.equal(formatRuntimeErrorForTui("fetch failed"), "fetch failed");
  assert.equal(
    formatRuntimeErrorForTui("rin_request_failed"),
    "request failed",
  );
  assert.equal(formatRuntimeErrorForTui("rin_app_tui_failed"), "tui failed");
  assert.equal(
    formatRuntimeErrorForTui("frontend_model_not_found:openai/missing"),
    "frontend model not found: openai/missing",
  );
  assert.equal(formatRuntimeErrorForTui(""), "unknown error");
});

test("chat error formatter prefixes terse Rin errors", () => {
  assert.equal(
    formatRuntimeErrorForChat("rin_request_failed"),
    "rin error: request failed",
  );
  assert.equal(
    formatRuntimeErrorForChat("prompt is too long"),
    "rin error: prompt is too long",
  );
  assert.equal(
    formatRuntimeErrorForChat("rin error: request failed"),
    "rin error: request failed",
  );
});

test("runtime error formatter maps known internal markers to actionable messages", () => {
  assert.equal(
    formatRuntimeErrorForUser("new_session_session_file_unsupported"),
    "Could not start a new chat session because the command was bound to a replied message's old session.",
  );
  assert.equal(
    formatRuntimeErrorForUser("frontend_model_not_found:openai/missing"),
    "Model not found: openai/missing. Choose an available model in /model or settings.",
  );
  assert.equal(
    formatRuntimeErrorForUser("rin_worker_exit"),
    "Rin's background worker exited before the request finished.",
  );
  assert.equal(
    formatRuntimeErrorForUser("rin_no_attached_session"),
    "Rin could not find a session attached to this chat command.",
  );
  assert.equal(
    formatRuntimeErrorForUser("run_managed_session_value_required"),
    "Run command needs a managed session name. Provide a leaf such as subagent.",
  );
  assert.equal(
    formatRuntimeErrorForUser("run_session_conflict"),
    "Choose either --session or --managed-session, not both.",
  );
  assert.equal(
    formatRuntimeErrorForUser("rpc_turn_final_output_missing"),
    "Rin finished the turn without a final reply.",
  );
  assert.equal(
    formatRuntimeErrorForUser("rin_turn_result_invariant_failed"),
    "Rin's remote turn ended without a durable terminal result.",
  );
  assert.equal(
    formatRuntimeErrorForUser("rin_turn_result_recovery_timeout"),
    "Rin could not recover the remote turn result before the timeout.",
  );
  assert.equal(
    /retry|restart|doctor|check the session output/i.test(
      formatRuntimeErrorForUser("rpc_turn_final_output_missing"),
    ),
    false,
  );
  assert.equal(
    formatRuntimeErrorForUser(
      "rin_daemon_unavailable: managed daemon service did not become available",
    ),
    "Rin's background service is not available: managed daemon service did not become available.",
  );
});

test("runtime error formatter hides unmapped internal markers from user-facing text", () => {
  const text = formatRuntimeErrorForUser("some_new_internal_marker:debug_code");
  assert.equal(
    text,
    "Rin hit an internal runtime problem before it could finish.",
  );
  assert.equal(text.includes("some_new_internal_marker"), false);
  assert.equal(text.includes("debug_code"), false);

  const embedded = formatRuntimeErrorForUser("Browse failed: fetch_failed");
  assert.match(embedded, /network request failed/i);
  assert.equal(embedded.includes("fetch_failed"), false);

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

test("runtime error formatter does not add generic recovery advice", () => {
  const bannedAdvice =
    /\b(retry|try again)\b|restart Rin|run rin doctor|rin doctor|if it repeats/i;
  const markers = collectRinOwnedErrorMarkers();
  assert.ok(markers.size > 0);
  assert.equal(
    bannedAdvice.test(formatRuntimeErrorForUser("unknown_internal_marker")),
    false,
  );
  for (const marker of markers) {
    const formatted = formatRuntimeErrorForUser(marker);
    assert.equal(
      bannedAdvice.test(formatted),
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

test("tui entrypoints keep Pi-style caught errors before printing", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const entrypoints = ["src/app/rin-tui/main.ts", "src/core/rin-tui/main.ts"];
  for (const relative of entrypoints) {
    const text = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.match(text, /formatRuntimeErrorForTui\(error \|\|/);
    assert.doesNotMatch(text, /formatRuntimeErrorForUser\(error \|\|/);
    assert.doesNotMatch(text, /console\.error\(String\(error\?\.message/);
  }
});

test("non-tui app entrypoints format caught errors before printing", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const entrypoints = [
    "src/app/rin/main.ts",
    "src/app/rin-install/main.ts",
    "src/app/rin-gui/main.ts",
    "src/app/rin-desktop-host/main.ts",
    "src/app/rin-daemon/daemon.ts",
    "src/app/rin-daemon/worker.ts",
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
