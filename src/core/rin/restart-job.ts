import {
  independentJobPath,
  launchIndependentJob,
  runIndependentJobExecutor,
  type IndependentJobExecutorDependencies,
  type IndependentJobLauncherDependencies,
  type IndependentJobRecord,
} from "./independent-job.js";
import { RIN_DAEMON_WORKER_OWNER_ENV } from "../rin-lib/profile.js";

const UPDATE_JOB_AUTH_ENV = "RIN_UPDATE_JOB_AUTH";
const UPDATE_JOB_TOKEN_ENV = "RIN_UPDATE_JOB_TOKEN";

export function restartJobPath(installDir: string, id: string) {
  return independentJobPath(installDir, "restart", id);
}

export async function launchIndependentRestartJob(
  options: {
    targetUser: string;
    installDir: string;
    nodePath: string;
    rinEntryPath: string;
    executorEntryPath: string;
    restartArgs: string[];
    cwd: string;
    callerPid?: number;
  },
  dependencies: IndependentJobLauncherDependencies = {},
) {
  return await launchIndependentJob(
    {
      kind: "restart",
      targetUser: options.targetUser,
      installDir: options.installDir,
      nodePath: options.nodePath,
      payloadEntryPath: options.rinEntryPath,
      executorEntryPath: options.executorEntryPath,
      payloadArgs: options.restartArgs,
      cwd: options.cwd,
      waitForPid: options.callerPid ?? process.pid,
    },
    dependencies,
  );
}

export function restartJobProcessEnvironment(
  record: Pick<IndependentJobRecord, "environment">,
) {
  const environment: NodeJS.ProcessEnv = { ...record.environment };
  delete environment[RIN_DAEMON_WORKER_OWNER_ENV];
  delete environment[UPDATE_JOB_AUTH_ENV];
  delete environment[UPDATE_JOB_TOKEN_ENV];
  return environment;
}

export async function runRestartJobExecutor(
  jobPath: string,
  dependencies: IndependentJobExecutorDependencies = {},
) {
  return await runIndependentJobExecutor(
    jobPath,
    {
      expectedKind: "restart",
      childEnvironment: restartJobProcessEnvironment,
    },
    dependencies,
  );
}
