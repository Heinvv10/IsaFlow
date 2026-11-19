/**
 * Cancelling an off-cycle run that is not final (wave 6 OC, UI review #1620 H): a draft or calculated bonus or
 * termination run that cannot be approved (its pay date passed, it pays nothing) is otherwise a dead end, and its
 * employees could join no other off-cycle run of the month. Cancel sets status 'cancelled' and deletes its lines; the
 * header and its payroll_off_cycle_employees rows stay as the record of what was cancelled.
 *
 * Why every reader then ignores it:
 *  - EMP201, the year to date, the payslip finality, the 13-week forecast and the journal readers read FINAL runs only
 *    (payRunFinalSql: approved or paid); the owner cash position reads draft, calculated and approved runs only; and the
 *    run has no lines left for any line reader.
 *  - The open-run check at create, the pay-order check and the month's basis read non-cancelled runs only.
 *  - Calculate-time rows keyed to a run: an off-cycle run takes no loan instalment (payrollRunService skips
 *    applyRunLoans), and regular-pay directive uses and severance claims are written at APPROVAL only
 *    (payrollRunDirectiveClaim). A run that ever carried a journal, a directive use, a claim or a loan payment is
 *    therefore one that was approved before, and it is refused (reopen keeps those records).
 *  - Off-cycle runs never close a month's ETI (payrollRunCadence), so no regular run's ETI depends on it.
 * Owner or admin, never under Login-as (the route); refused with 409 before any write.
 */
import { withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { mapRunRow, type PayrollRunSummary } from './payrollRunHeaders';
import { OffCycleRunRefusedError } from './payrollOffCycleRun';

const refused = (m: string) => new OffCycleRunRefusedError(m, 409);

export async function cancelOffCycleRun(companyId: string, runId: string, userId: string | null): Promise<PayrollRunSummary | null> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  return withTransaction(async (tx) => {
    const run = ((await tx`
      SELECT h.*,
             (h.journal_entry_id IS NOT NULL
              OR EXISTS (SELECT 1 FROM payroll_run_directive_uses d WHERE d.run_id = h.id AND d.company_id = h.company_id)
              OR EXISTS (SELECT 1 FROM tax_directive_payments t WHERE t.payroll_run_id = h.id AND t.company_id = h.company_id)
              OR EXISTS (SELECT 1 FROM payroll_loan_payments p WHERE p.run_id = h.id)) AS ever_approved
        FROM payroll_run_headers h
       WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
       FOR UPDATE OF h
    `) as DbRow[])[0];
    if (!run) return null;
    if (run.run_kind !== 'off_cycle') throw refused('Only an off-cycle run can be cancelled.');
    if (run.status !== 'draft' && run.status !== 'calculated') {
      throw refused(`This off-cycle run is ${String(run.status)}: only a draft or calculated off-cycle run can be cancelled.`);
    }
    if (run.ever_approved === true) {
      throw refused('This off-cycle run was approved before (it carries a journal, a directive or a loan payment), so it cannot be cancelled.');
    }
    await tx`DELETE FROM payroll_run_lines WHERE run_id = ${runId}::uuid`;
    const rows = (await tx`
      UPDATE payroll_run_headers
         SET status = 'cancelled', total_gross = 0, total_taxable = 0, total_paye = 0, total_uif = 0, total_sdl = 0,
             total_eti = 0, total_net = 0, employee_count = 0, approval_plan_hash = NULL
       WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
       RETURNING *
    `) as DbRow[];
    log.info('Off-cycle payroll run cancelled', { companyId, runId, previousStatus: String(run.status), userId }, 'payrollOffCycleCancel');
    return mapRunRow(rows[0]!);
  });
}
