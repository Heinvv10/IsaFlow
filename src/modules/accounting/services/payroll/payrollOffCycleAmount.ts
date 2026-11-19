/**
 * Correcting a bonus amount on an off-cycle run (wave 6 OC, review #1620 final breaker M). An over-payment keyed in
 * error (R50 000 for R5 000) is corrected on the run itself: reopen it (allowed while its month's EMP201 is not filed,
 * payrollOffCycleGates.offCyclePaidReopenRefusal), change the amount here, recalculate and approve it again.
 *
 * Only a draft or calculated BONUS run's amount changes (the 999x guard holds the same rule for app_user). The run's
 * lines are removed and it goes back to draft, so nothing costed on the old amount can be approved: the zero-gross
 * refusal holds the approval until it is recalculated. A pending R-035 request is refused here (withdraw it first):
 * its digest was taken on the old figures. Recovering cash already paid is outside payroll.
 * Every edit writes an audit row (old and new amount). Owner or admin on a cookie session only, never under Login-as
 * and never for an agent (the route takes no bearer token); refused with 409 before any write.
 */
import { withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { isWholeCents, MAX_BONUS, OffCycleRunRefusedError } from './payrollOffCycleRun';
import { offCycleRaiseRefusal } from './payrollOffCycleCorrection';
import { formatMoney } from '@/lib/money/formatMoney';
import { logAuditOrThrow } from '../core/auditTrailService';

const refused = (m: string, status: 400 | 409 = 409) => new OffCycleRunRefusedError(m, status);

export interface OffCycleBonusInput {
  employeeId: string;
  employeeName: string;
  amount: number;
}

/** A bonus run's inputs, for the run page; [] for any other run. */
export async function listOffCycleBonusInputs(companyId: string, runId: string): Promise<OffCycleBonusInput[]> {
  return withTransaction(async (tx) => {
    const rows = (await tx`
      SELECT x.employee_id::text AS employee_id, x.amount::float8 AS amount,
             TRIM(CONCAT(e.first_name, ' ', e.last_name)) AS name
        FROM payroll_off_cycle_employees x
        JOIN payroll_run_headers h ON h.id = x.run_id AND h.company_id = x.company_id
        JOIN payroll_employees e ON e.id = x.employee_id AND e.company_id = x.company_id
       WHERE x.company_id = ${companyId}::uuid AND x.run_id = ${runId}::uuid AND h.off_cycle_reason = 'bonus'
       ORDER BY name, x.employee_id
    `) as DbRow[];
    return rows.map((r) => ({ employeeId: String(r.employee_id), employeeName: String(r.name), amount: Number(r.amount) }));
  });
}

/** Set one employee's bonus amount on a draft or calculated bonus run; null when the run is not this company's. */
export async function setOffCycleBonusAmount(
  companyId: string, runId: string, employeeId: string, entered: number, userId: string,
): Promise<{ runId: string; employeeId: string; amount: number } | null> {
  await assertNotImpersonating(); // R-032 L5: first, before any read or write
  // The same judgment as the create path (judgeOffCycleShape): exact float equality refused R1.15 and R1 000.10.
  // The same ceiling as create (MAX_BONUS, review #1620 final delta L2).
  if (!Number.isFinite(entered) || entered <= 0 || entered > MAX_BONUS || !isWholeCents(entered)) {
    throw refused(`The bonus amount must be more than R0 and at most ${formatMoney(MAX_BONUS)}, in rand and cents.`, 400);
  }
  const amount = Math.round(entered * 100) / 100;
  return withTransaction(async (tx) => {
    const run = ((await tx`
      SELECT h.id, h.run_kind, h.off_cycle_reason, h.status, h.run_date, h.period_year, h.period_month, h.off_cycle_paid_gross, h.approval_history
        FROM payroll_run_headers h
       WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
       FOR UPDATE OF h
    `) as DbRow[])[0];
    if (!run) return null;
    if (run.run_kind !== 'off_cycle' || run.off_cycle_reason !== 'bonus') throw refused('Only a bonus run\'s amounts can be changed.');
    if (run.status !== 'draft' && run.status !== 'calculated') {
      throw refused(`This bonus run is ${String(run.status)}: reopen it first (allowed until its month's EMP201 is filed).`);
    }
    const pending = (await tx`
      SELECT 1 FROM approval_requests
       WHERE company_id = ${companyId}::uuid AND document_type = 'pay_run' AND document_id = ${runId}::uuid AND status = 'pending'
    `) as DbRow[];
    if (pending.length > 0) throw refused('This run has a pending approval request: withdraw it before changing an amount.');
    const before = ((await tx`
      SELECT amount::text AS amount FROM payroll_off_cycle_employees
       WHERE company_id = ${companyId}::uuid AND run_id = ${runId}::uuid AND employee_id = ${employeeId}::uuid
       FOR UPDATE
    `) as DbRow[])[0];
    if (!before) throw refused('That employee is not on this bonus run.', 400);
    // After its pay date a run's amounts were paid: a correction only lowers them (delta M1).
    const raised = offCycleRaiseRefusal(run, employeeId, amount);
    if (raised) throw refused(raised);
    // Nothing costed on the old amount can be approved: back to draft and no lines FIRST (the 999x guard changes an
    // amount on a draft run only, delta L1), until it is recalculated.
    await tx`DELETE FROM payroll_run_lines WHERE run_id = ${runId}::uuid`;
    await tx`
      UPDATE payroll_run_headers
         SET status = 'draft', total_gross = 0, total_taxable = 0, total_paye = 0, total_uif = 0, total_sdl = 0,
             total_eti = 0, total_net = 0, employee_count = 0, approval_plan_hash = NULL
       WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
    `;
    await tx`
      UPDATE payroll_off_cycle_employees SET amount = ${amount}
       WHERE company_id = ${companyId}::uuid AND run_id = ${runId}::uuid AND employee_id = ${employeeId}::uuid
    `;
    // Every edit leaves an audit row with the old and new amount, in this transaction (it commits with the change).
    await logAuditOrThrow({
      companyId, userId, action: 'update', entityType: 'payroll_run', entityId: runId,
      changes: {
        fields: [{ field: 'off_cycle_bonus_amount', old: String(before.amount), new: amount.toFixed(2), label: 'Bonus amount' }],
        metadata: { employeeId, previousStatus: String(run.status) },
      },
    }, tx);
    log.info('Off-cycle bonus amount changed', { companyId, runId, employeeId, amount, previousStatus: String(run.status), userId }, 'payrollOffCycleAmount');
    return { runId, employeeId, amount };
  });
}
