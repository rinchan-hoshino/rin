import fs from "node:fs";
import path from "node:path";

if (
  process.env.RIN_SYSTEM_TEST_CONTAINER_INNER !== "1" ||
  !fs.existsSync("/.dockerenv")
) {
  throw new Error("test_container_required:use_npm_run_test_container");
}

const rootValue = process.env.RIN_TEST_SANDBOX_ROOT;
if (!rootValue) throw new Error("test_sandbox_root_missing");
const root = path.resolve(rootValue);
for (const name of [
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "RIN_DAEMON_SOCKET_PATH",
]) {
  const value = process.env[name];
  if (!value) throw new Error(`test_sandbox_path_missing:${name}`);
  const resolved = path.resolve(value);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`test_sandbox_path_escape:${name}:${resolved}`);
  }
}
for (const name of ["RIN_DIR", "RIN_AGENT_DIR"]) {
  const value = process.env[name];
  if (!value) continue;
  const resolved = path.resolve(value);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`test_sandbox_path_escape:${name}:${resolved}`);
  }
}
if (process.env.NO_PROXY !== "") {
  throw new Error("test_network_bypass_forbidden");
}
