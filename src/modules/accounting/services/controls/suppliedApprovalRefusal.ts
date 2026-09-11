/**
 * The failures that belong to a CALLER-SUPPLIED approval: a wrong id, a
 * rejected or expired decision, an approver who lost the authority, material
 * that moved on. A transport answers these as a conflict, because retrying the
 * same call unchanged cannot help and the caller can fix them.
 *
 * Deliberately a declared class, not "any error without a SQLSTATE": the same
 * region also raises stored-approval INTEGRITY failures ('Approval material is
 * invalid' — a tamper/canonicalisation detector) and can raise programming
 * faults, and neither is the caller's mistake. Those must stay server failures
 * so monitoring sees them and their message is never echoed back.
 */
export class SuppliedApprovalRefusal extends Error {
  readonly code = 'OPERATION_APPROVAL_NOT_EXECUTABLE';
  constructor(message: string) { super(message); this.name = 'SuppliedApprovalRefusal'; }
}

/**
 * True when a caller-supplied approval, not the server, is what failed. The
 * marker covers the control functions' own RAISEs, which arrive as pg errors
 * and cannot be instances of the class.
 */
export function isSuppliedApprovalRefusal(error: unknown): boolean {
  if (error instanceof SuppliedApprovalRefusal) return true;
  if (typeof error !== 'object' || error === null) return false;
  return (error as { suppliedApprovalRefusal?: unknown }).suppliedApprovalRefusal === true;
}

/**
 * What the caller may be told. Only text the control code wrote: a SuppliedApprovalRefusal, or a control
 * function's own RAISE (pg reports routine 'exec_stmt_raise' for a PL/pgSQL RAISE). A 42501 is marked by SQLSTATE
 * alone, and pg raises 42501 itself for a missing grant or a broken request context ("permission denied for table
 * …", routine 'aclcheck_error'): that text is never echoed — the marker's log line records it.
 */
export function suppliedApprovalRefusalText(error: unknown): string {
  if (error instanceof SuppliedApprovalRefusal) return error.message;
  const authoredRaise = error instanceof Error && (error as { routine?: unknown }).routine === 'exec_stmt_raise';
  return authoredRaise ? (error as Error).message : 'the approval could not be checked';
}
