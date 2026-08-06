import fs from "node:fs";

export function requireTestContainer(
  env: NodeJS.ProcessEnv = process.env,
  containerEvidence = fs.existsSync("/.dockerenv"),
): void {
  if (env.RIN_SYSTEM_TEST_CONTAINER_INNER !== "1" || !containerEvidence) {
    throw new Error("test_container_required:use_npm_run_test_container");
  }
}
