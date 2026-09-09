/**
 * Payroll-run lock primitives.
 *
 * A run is "locked" when its status is in LOCKED_STATUSES — at that point
 * recalculation, line edits, and approve/cancel transitions all reject.
 * The only way out of a locked state is reopenPayrollRun(), which:
 *   • requires a non-empty reason (audited)
 *   • only allows approved → calculated
 *   • paid runs cannot be reopened (money has moved — needs a reversing run)
 *   • cancelled runs cannot be reopened (create a new run instead)
 */


export type PayrollRunStatus = 'draft' | 'calculated' | 'approved' | 'paid' | 'cancelled';

const LOCKED_STATUSES = new Set<string>(['approved', 'paid', 'cancelled']);

export function isPayrollRunLocked(status: string): boolean {
  return LOCKED_STATUSES.has(status);
}

export class PayrollRunLockedError extends Error {
  readonly status: string;
  constructor(status: string) {
    super(
      status === 'paid'
        ? 'Payroll run is paid — payments have been issued. Reverse via a new run.'
        : status === 'cancelled'
        ? 'Payroll run is cancelled — create a new run for this period.'
        : `Payroll run is ${status} (locked). Reopen it first if you need to edit.`
    );
    this.name = 'PayrollRunLockedError';
    this.status = status;
  }
}

export async function reopenPayrollRun(opts: {
  runId:string;companyId:string;userId:string;reason:string;approvalId?:string;reversalDate?:string;
}):Promise<{runId:string;previousStatus:string;newStatus:'calculated'}> {
  if (typeof opts.reason !== 'string' || opts.reason.trim().length < 5 || opts.reason.trim().length > 2000) throw new Error('Reopen reason must contain 5 to 2000 characters');
  const {executePayrollReopen}=await import('./payrollControlService');
  const result=await executePayrollReopen(opts.companyId,opts.runId,opts.userId,{...opts,reason:opts.reason.trim()});
  return {runId:result.runId,previousStatus:result.previousStatus,newStatus:result.newStatus};
}
