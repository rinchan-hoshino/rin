import fs from "node:fs";
import path from "node:path";

export const RIN_UPDATE_JOB_PATH_ENV = "RIN_UPDATE_JOB_PATH";
export const RIN_UPDATE_JOB_ID_ENV = "RIN_UPDATE_JOB_ID";

function authorizationError(): never {
  throw new Error("rin_update_job_authorization_required");
}

export function updateJobProcessEnvironment(
  jobPath: string,
  jobId: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    [RIN_UPDATE_JOB_PATH_ENV]: jobPath,
    [RIN_UPDATE_JOB_ID_ENV]: jobId,
  };
}

export function forwardedUpdateJobEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const jobPath = String(env[RIN_UPDATE_JOB_PATH_ENV] || "").trim();
  const jobId = String(env[RIN_UPDATE_JOB_ID_ENV] || "").trim();
  return jobPath && jobId
    ? {
        [RIN_UPDATE_JOB_PATH_ENV]: jobPath,
        [RIN_UPDATE_JOB_ID_ENV]: jobId,
      }
    : {};
}

export function activateLegacyUpdateHandoff(
  argv: string[],
  installDir: string,
  env: NodeJS.ProcessEnv = process.env,
  parentPid = process.ppid,
) {
  const retired = () => {
    throw new Error("rin_installer_update_entry_removed");
  };
  if (!argv.includes("--update") || !argv.includes("--preconfirmed")) {
    return retired();
  }
  const jobDir = path.join(
    String(installDir || "").trim(),
    "data",
    "core",
    "updates",
    "jobs",
  );
  let matches: Array<{ id: string; path: string }> = [];
  try {
    matches = fs
      .readdirSync(jobDir)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const jobPath = path.join(jobDir, name);
        const record = JSON.parse(fs.readFileSync(jobPath, "utf8"));
        return record?.version === 1 &&
          record?.status === "running" &&
          record?.pid === parentPid &&
          path.basename(jobPath) === `${record?.id}.json`
          ? [{ id: record.id, path: jobPath }]
          : [];
      });
  } catch {
    return retired();
  }
  if (matches.length !== 1) return retired();
  env[RIN_UPDATE_JOB_PATH_ENV] = matches[0].path;
  env[RIN_UPDATE_JOB_ID_ENV] = matches[0].id;
  return argv.filter((arg) => arg !== "--update");
}

export function assertAuthorizedUpdateJob(
  installDir: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const expectedJobDir = path.resolve(
    String(installDir || "").trim(),
    "data",
    "core",
    "updates",
    "jobs",
  );
  const jobPathValue = String(env[RIN_UPDATE_JOB_PATH_ENV] || "").trim();
  const jobId = String(env[RIN_UPDATE_JOB_ID_ENV] || "").trim();
  if (
    !installDir ||
    !jobPathValue ||
    !jobId ||
    !path.isAbsolute(jobPathValue)
  ) {
    return authorizationError();
  }
  const jobPath = path.resolve(jobPathValue);
  if (
    path.dirname(jobPath) !== expectedJobDir ||
    path.basename(jobPath) !== `${jobId}.json`
  ) {
    return authorizationError();
  }
  try {
    const record = JSON.parse(fs.readFileSync(jobPath, "utf8"));
    if (
      record?.version !== 1 ||
      record?.id !== jobId ||
      record?.status !== "running"
    ) {
      return authorizationError();
    }
  } catch {
    return authorizationError();
  }
  return { id: jobId, path: jobPath };
}
