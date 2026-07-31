import {
  acknowledgeSelfImproveRunAudit,
  beginSelfImproveRunAudit,
  completeSelfImproveRunAudit,
  maintainSelfImproveRunAuditStorage,
  sanitizeSelfImproveHistoryText,
  type SelfImproveRunAuditHandle,
  type SelfImproveRunAuditReference,
} from "./run-audit.js";

// Audit is an observational side effect. Queue and scheduler state alone own
// execution, retry, and terminal lifecycle decisions.
function auditErrorText(error: unknown) {
  const message = String(
    (error as any)?.message || error || "self_improve_audit_failed",
  ).trim();
  return sanitizeSelfImproveHistoryText(message, 64 * 1024).text;
}

export function combineSelfImproveAuditErrors(
  current: string | undefined,
  error: unknown,
) {
  const next = auditErrorText(error);
  if (!current) return next;
  if (current.split("; ").includes(next)) return current;
  return `${current}; ${next}`;
}

export function reportSelfImproveAuditObservationError(error: unknown) {
  console.error(`[rin-self-improve-audit] ${auditErrorText(error)}`);
}

export async function beginSelfImproveAuditObservation(
  input: Parameters<typeof beginSelfImproveRunAudit>[0],
): Promise<{ handle?: SelfImproveRunAuditHandle; auditError?: string }> {
  try {
    return { handle: await beginSelfImproveRunAudit(input) };
  } catch (error) {
    return { auditError: auditErrorText(error) };
  }
}

export async function completeSelfImproveAuditObservation(
  input: Omit<Parameters<typeof completeSelfImproveRunAudit>[0], "handle"> & {
    handle?: SelfImproveRunAuditHandle;
    auditError?: string;
  },
): Promise<{
  audit?: SelfImproveRunAuditReference;
  auditHandle?: SelfImproveRunAuditHandle;
  changedFiles: Array<{
    path: string;
    change: "created" | "updated" | "deleted";
  }>;
  auditError?: string;
}> {
  let audit: SelfImproveRunAuditReference | undefined;
  let changedFiles: Array<{
    path: string;
    change: "created" | "updated" | "deleted";
  }> = [];
  let auditError = input.auditError;
  if (input.handle) {
    try {
      const completed = await completeSelfImproveRunAudit({
        ...input,
        handle: input.handle,
      });
      audit = completed;
      changedFiles = completed.changedFiles;
    } catch (error) {
      auditError = combineSelfImproveAuditErrors(auditError, error);
    }
  }
  try {
    await maintainSelfImproveRunAuditStorage({ agentDir: input.agentDir });
  } catch (error) {
    auditError = combineSelfImproveAuditErrors(auditError, error);
  }
  return {
    audit,
    auditHandle: input.handle,
    changedFiles,
    auditError,
  };
}

export async function acknowledgeSelfImproveAuditObservation(input: {
  agentDir: string;
  handle?: SelfImproveRunAuditHandle;
  reference?: SelfImproveRunAuditReference;
  auditError?: string;
}) {
  if (!input.handle || !input.reference) return input.auditError;
  try {
    await acknowledgeSelfImproveRunAudit({
      agentDir: input.agentDir,
      handle: input.handle,
      reference: input.reference,
    });
    return input.auditError;
  } catch (error) {
    return combineSelfImproveAuditErrors(input.auditError, error);
  }
}
