import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { runFrontendEntrypoint } from "../../src/core/rin-frontend-sdk/entrypoint.js";
import {
  formatRuntimeErrorForChat,
  formatRuntimeErrorForFrontendDisplay,
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

test("runtime error formatter maps system errno messages through platform descriptions", () => {
  assert.equal(
    formatRuntimeErrorForUser(
      "Unknown system error -122: Unknown system error -122, write",
    ),
    "write failed: EDQUOT: disk quota exceeded",
  );
  assert.equal(
    formatRuntimeErrorForUser(
      Object.assign(new Error("Unknown system error -122"), {
        errno: -122,
        syscall: "write",
        path: "/tmp/rin-install/result.json",
      }),
    ),
    "write failed: EDQUOT: disk quota exceeded (/tmp/rin-install/result.json)",
  );
});

test("frontend display error formatter keeps terse marker-derived errors", () => {
  assert.equal(
    formatRuntimeErrorForFrontendDisplay("fetch failed"),
    "fetch failed",
  );
  assert.equal(
    formatRuntimeErrorForFrontendDisplay("rin_request_failed"),
    "request failed",
  );
  assert.equal(
    formatRuntimeErrorForFrontendDisplay("rin_app_tui_failed"),
    "tui failed",
  );
  assert.equal(
    formatRuntimeErrorForFrontendDisplay(
      "frontend_model_not_found:openai/missing",
    ),
    "frontend model not found: openai/missing",
  );
  assert.equal(formatRuntimeErrorForFrontendDisplay(""), "unknown error");
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
    formatRuntimeErrorForUser("chat_message_store_chatKey_required"),
    "Stored chat message access requires an exact chat key.",
  );
  assert.equal(
    formatRuntimeErrorForUser("rin_worker_oom"),
    "Rin's background worker ran out of memory.",
  );
  assert.equal(
    formatRuntimeErrorForUser("rin_worker_cleanup_failed"),
    "Rin could not finish cleaning up the background worker.",
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
    formatRuntimeErrorForUser("rin_turn_result_recovery_timeout"),
    "Rin could not recover the remote turn result before the timeout.",
  );
  assert.equal(
    formatRuntimeErrorForUser("rin_managed_node_runtime_missing:/tmp/node"),
    "Rin could not find its managed Node runtime. Repair or reinstall Rin before starting managed services or updating.",
  );
  assert.equal(
    formatRuntimeErrorForUser("rin_update_platform_bundle_checksum_missing"),
    "Rin update could not verify the platform bundle because its checksum is missing.",
  );
  assert.equal(
    formatRuntimeErrorForUser("rin_update_platform_bundle_checksum_mismatch"),
    "Rin update stopped because the platform bundle checksum did not match.",
  );
  assert.equal(
    formatRuntimeErrorForUser(
      "rin_daemon_unavailable: managed daemon service did not become available",
    ),
    "Rin's background service is not available: managed daemon service did not become available.",
  );
  assert.equal(
    formatRuntimeErrorForUser("pi_prompt_shape_changed:Guidelines"),
    "Rin stopped because Pi's system prompt structure changed and Rin could not apply its prompt overlay safely.",
  );
});

test("runtime error formatter keeps unmapped internal marker detail readable", () => {
  const text = formatRuntimeErrorForUser("some_new_internal_marker:debug_code");
  assert.equal(text, "some new internal marker: debug_code");

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

test("tui entrypoints delegate caught-error display to the shared frontend boundary", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const entrypoints = ["src/app/rin-tui/main.ts", "src/core/rin-tui/main.ts"];
  for (const relative of entrypoints) {
    const text = fs.readFileSync(path.join(repoRoot, relative), "utf8");
    assert.match(text, /runFrontendEntrypoint\(startTui\)/);
    assert.match(text, /rin-frontend-sdk\/entrypoint\.js/);
    assert.doesNotMatch(text, /formatRuntimeErrorFor/);
    assert.doesNotMatch(text, /console\.error\(/);
  }

  assert.equal(
    fs.existsSync(path.join(repoRoot, "src/core/rin-tui/entrypoint.ts")),
    false,
  );

  const displayBoundary = fs.readFileSync(
    path.join(repoRoot, "src/core/rin-frontend-sdk/entrypoint.ts"),
    "utf8",
  );
  assert.match(
    displayBoundary,
    /stderr\.error\(formatRuntimeErrorForFrontendDisplay\(error\)\)/,
  );
  assert.doesNotMatch(displayBoundary, /fallback/i);
  assert.doesNotMatch(displayBoundary, /formatRuntimeErrorForTui/);
});

test("shared frontend entrypoint formats caught errors exactly at display", async () => {
  const printed: string[] = [];
  const exits: number[] = [];

  await runFrontendEntrypoint(
    () => {
      throw new Error("rin_request_failed");
    },
    {
      stderr: { error: (message: string) => printed.push(message) },
      exit: (code: number) => exits.push(code),
    },
  );

  assert.deepEqual(printed, ["request failed"]);
  assert.deepEqual(exits, [1]);
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
