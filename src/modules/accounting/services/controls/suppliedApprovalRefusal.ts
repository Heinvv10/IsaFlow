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

/** The refusal's own message is safe to show: it is written here, never by pg. */
export function suppliedApprovalRefusalText(error: unknown): string {
  return error instanceof Error ? error.message : 'the approval cannot be used';
}
