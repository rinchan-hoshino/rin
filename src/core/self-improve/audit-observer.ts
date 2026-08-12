import {
  beginSelfImproveRunAudit,
  completeSelfImproveRunAudit,
  sanitizeSelfImproveHistoryText,
  type SelfImproveRunAuditCapture,
  type SelfImproveRunAuditReference,
} from "./run-audit.js";

// Audit observes a run. Queue and scheduler state alone own execution,
// interruption, retry, and terminal lifecycle decisions.
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
): Promise<{ capture?: SelfImproveRunAuditCapture; auditError?: string }> {
  try {
    return { capture: await beginSelfImproveRunAudit(input) };
  } catch (error) {
    return { auditError: auditErrorText(error) };
  }
}

export async function completeSelfImproveAuditObservation(
  input: Omit<Parameters<typeof completeSelfImproveRunAudit>[0], "capture"> & {
    capture?: SelfImproveRunAuditCapture;
    auditError?: string;
  },
): Promise<{
  audit?: SelfImproveRunAuditReference;
  changedFiles: Array<{
    path: string;
    change: "created" | "updated" | "deleted";
  }>;
  auditError?: string;
}> {
  if (!input.capture) {
    return { changedFiles: [], auditError: input.auditError };
  }
  try {
    const completed = await completeSelfImproveRunAudit({
      ...input,
      capture: input.capture,
    });
    return {
      audit: completed,
      changedFiles: completed.changedFiles,
      auditError: input.auditError,
    };
  } catch (error) {
    return {
      changedFiles: [],
      auditError: combineSelfImproveAuditErrors(input.auditError, error),
    };
  }
}
