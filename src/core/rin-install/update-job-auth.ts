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
