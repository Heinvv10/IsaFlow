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
