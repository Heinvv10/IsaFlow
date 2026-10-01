/**
 * A refusal raised before approvePayrollRun writes anything (K-079). Callers
 * answer it as a 4xx — or, in MCP, return it as a tool error — because nothing
 * has been written; anything else may follow the status write and must roll
 * back. Its own module so a caller can branch on the real class without
 * importing the DB-backed service.
 */
export class PayrollApprovalRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayrollApprovalRefusedError';
  }
}

const APPROVABLE_STATUSES = ['draft', 'calculated', 'processed'];

/**
 * The status gate approvePayrollRun applies before anything else, as the
 * refusal message it throws, or null when the status may be approved. An
 * 'approved' run whose journal never posted (stranded before K-079) may be
 * re-approved; one that carries its journal may not. One copy, shared by
 * approval and by its preview, so the confirmation refuses exactly what
 * approval refuses.
 */
export function approvalStatusRefusal(status: string, journalEntryId: string | null): string | null {
  if (APPROVABLE_STATUSES.includes(status)) return null;
  if (status === 'approved' && journalEntryId == null) return null;
  return `Cannot approve payroll run with status '${status}' (expected one of: ${APPROVABLE_STATUSES.join(', ')})`;
}

/**
 * The run no longer matches the preview the caller approved from — someone
 * recalculated or approved it in between. Raised before any write; answered
 * as a 409 so the page refetches the preview.
 */
export class PayrollApprovalConflictError extends PayrollApprovalRefusedError {
  constructor(message: string) {
    super(message);
    this.name = 'PayrollApprovalConflictError';
  }
}
