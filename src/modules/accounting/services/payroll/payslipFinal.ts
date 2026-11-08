/**
 * Whether a pay run's payslips are final (wave 5 FS). The stamp decides:
 * `payslips_final_at` is set by the approve UPDATE (payrollApprovalService), which runs the
 * R-035 guard first, and cleared by reopen (payrollRunReopen). Migration 968 stamped every
 * run already approved or paid. NULL is DRAFT.
 *
 * Never the guard on read (wave 4 PS did, and a run approved while enforcement was off
 * turned DRAFT once it was switched on). Never a status string alone: a stamp counts only
 * while the run is approved or paid, so a header put back to another status is DRAFT even
 * if a writer forgot to clear the stamp.
 *
 * A failed read is a thrown error (a 500), never a slip that silently says DRAFT.
 */
import { sql } from '@/lib/neon';

export async function isPayRunFinal(companyId: string, runId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM payroll_run_headers
     WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
       AND status IN ('approved', 'paid') AND payslips_final_at IS NOT NULL
  `) as unknown[];
  return rows.length > 0;
}
