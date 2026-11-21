/**
 * The two judgements an off-cycle run adds to approval and reopen (wave 6 OC), each before any write.
 *
 *  - Approval: an off-cycle run is not approved after its pay date (run_date earlier than the approval day in South
 *    Africa). A run approved after the day it says it was paid is a payment nobody has made yet dated in the past:
 *    the owner cash position (ownerCashPosition, FQb2 #1549) treats a run whose pay date has passed as paid, so the
 *    bonus would leave the forecast unpaid (review #1549 delta-2 D1). Move the pay date by creating the run again.
 *  - Create and calculate (review #1575 carry 1, coordinator ruling 2026-11-18): an off-cycle run whose pay date is on or
 *    after its month's closing regular run (the monthly regular run, once calculated: its pay date is run_date, else
 *    period_end) is refused with 409. That regular run settled the month's UIF month to date and closed its ETI, so a
 *    payment after it falls after the month's close. Pay the off-cycle run before the regular run's pay date.
 *  - Reopen of a run: refused while a final off-cycle run later in its month and frequency exists. The off-cycle
 *    line's PAYE, UIF and ETI were costed on this run's line (the month's annual equivalent, the month's UIF cap and
 *    ETI), so changing it would leave those figures wrong. Reopen the off-cycle run first.
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { todayInSast } from '@/lib/saDateParser';
import { formatDisplayDate } from '@/utils/dateFormat';
import { payRunFinalSql } from './payRunFinalSql';
import { runOrderKeySql, runPayDateSql } from './payrollRunOrder';
import { dateColumnOf } from './payrollFrequency';
import { emp201FiledForMonth, wasApprovedBefore } from './payrollOffCycleCorrection';

/**
 * Why this off-cycle run cannot be reopened (review #1620 final breaker M, coordinator ruling; review #1679 M4): it is
 * reopened (to correct an amount keyed in error) only while its month's EMP201 is not filed: no finalised or filed EMP201
 * version for the month, and no legacy submitted or accepted EMP201 covering it. That holds on or before its pay date
 * too: the declaration counts the approved run, and once the month is filed the run is neither recalculated nor
 * approved again, so a reopen would take it out of payroll's totals for good. Judged before the status changes. A
 * correction after filing is wave 7. Null when it can be, or it is not off-cycle.
 */
export async function offCyclePaidReopenRefusal(
  companyId: string, run: { run_kind?: unknown; run_date?: unknown; period_year?: unknown; period_month?: unknown },
): Promise<string | null> {
  if (run.run_kind !== 'off_cycle') return null;
  const year = Number(run.period_year);
  const month = Number(run.period_month);
  const filed = await emp201FiledForMonth(companyId, year, month);
  if (!filed) return null;
  const payDate = dateColumnOf(run.run_date);
  const when = payDate === null ? '' : ` (pay date ${formatDisplayDate(payDate)})`;
  return `This off-cycle run${when}: its month's EMP201 is filed, so it is not reopened: `
    + 'the filed declaration stands. A correction after filing is made outside payroll for now.';
}


/** Why this off-cycle run cannot be approved today; null when it can (or it is not off-cycle). */
export function offCyclePayDateRefusal(run: { run_kind?: unknown; run_date?: unknown; approval_history?: unknown }, today: string = todayInSast()): string | null {
  if (run.run_kind !== 'off_cycle') return null;
  // A run approved before and reopened to correct it (final breaker M): its money is already out, so the cash-forecast
  // reason for this refusal (D1) does not apply; re-approving it after its pay date is allowed.
  if (wasApprovedBefore(run.approval_history)) return null;
  const payDate = dateColumnOf(run.run_date);
  if (payDate === null) return 'This off-cycle run has no pay date. Create it again with one.';
  return payDate < today
    ? `This off-cycle run's pay date (${formatDisplayDate(payDate)}) is before today (${formatDisplayDate(today)}): it cannot be `
      + 'approved after the day it says it was paid. Cancel it, then create the run again with a pay date of today or later.'
    : null;
}

/**
 * Why this run cannot be reopened: a FINAL off-cycle run later in its month (same frequency, after it in pay order)
 * was costed on its lines (review #1620 M1: a regular run, or an earlier off-cycle run). Null when it can.
 */
export async function laterOffCycleRefusal(companyId: string, runId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT o.id, o.off_cycle_reason
      FROM payroll_run_headers me
      JOIN payroll_run_headers o
        ON o.company_id = me.company_id AND o.period_year = me.period_year AND o.period_month = me.period_month
       AND o.pay_frequency = me.pay_frequency AND o.run_kind = 'off_cycle' AND o.id <> me.id
     WHERE me.id = ${runId}::uuid AND me.company_id = ${companyId}::uuid
       AND ${sql.unsafe(payRunFinalSql('o'))}
       AND ${runOrderKeySql('me')} < ${runOrderKeySql('o')}
     ORDER BY o.created_at, o.id
  `) as DbRow[];
  if (rows.length === 0) return null;
  const runs = rows.map((r) => `the ${String(r.off_cycle_reason)} run ${String(r.id)}`).join(', ');
  return `This month's approved off-cycle runs were costed on this run's lines (${runs}). Reopen ${rows.length === 1 ? 'it' : 'them'} first.`;
}

/**
 * Why this off-cycle run cannot be approved on the lines it was calculated on (review #1620 M1): an earlier run of its
 * month (same frequency, before it in pay order, with lines) is not final, or was approved after this run was
 * calculated (reopened and approved again). Either way the line's month (UIF room, ETI, the AE) is stale: approve
 * that run, then recalculate this one. Null when it can, or when the run is not off-cycle.
 */
export async function offCycleBasisRefusal(companyId: string, run: DbRow, db: TxSql = sql): Promise<string | null> {
  if (run.run_kind !== 'off_cycle') return null;
  const rows = (await db`
    SELECT o.run_kind, o.off_cycle_reason, ${sql.unsafe(payRunFinalSql('o'))} AS final,
           (me.calculated_at IS NULL OR o.approved_at > me.calculated_at) AS newer
      FROM payroll_run_headers me
      JOIN payroll_run_headers o
        ON o.company_id = me.company_id AND o.period_year = me.period_year AND o.period_month = me.period_month
       AND o.pay_frequency = me.pay_frequency AND o.id <> me.id AND o.status <> 'cancelled'
       -- A draft that was calculated (a bonus amount edit returns the run to draft, review #1679 Codex M) still holds
       -- the month this run was costed on: not approved. A draft never calculated costed nothing.
       AND (o.status <> 'draft' OR o.calculated_at IS NOT NULL)
     WHERE me.id = ${String(run.id)}::uuid AND me.company_id = ${companyId}::uuid
       AND ${runOrderKeySql('o')} < ${runOrderKeySql('me')}
     ORDER BY ${runOrderKeySql('o')}
  `) as DbRow[];
  const name = (r: DbRow) => (r.run_kind === 'off_cycle' ? `${String(r.off_cycle_reason)} run` : 'regular run');
  const open = rows.find((r) => r.final !== true);
  if (open) return `The month's ${name(open)} is not approved, and this run is costed on it: approve it, then recalculate this run.`;
  const newer = rows.find((r) => r.newer === true);
  if (newer) return `The month's ${name(newer)} was approved again after this run was calculated: recalculate this run, then approve it.`;
  return null;
}

/**
 * Why an off-cycle run of `period` paid on `payDate` cannot be created or costed: it is paid on or after the month's
 * closing regular run, once that run is calculated (calculated, approved or paid). Null when it can.
 */
export async function offCycleAfterCloseRefusal(
  companyId: string, period: { year: number; month: number }, payDate: string | null, db: TxSql = sql,
): Promise<string | null> {
  if (payDate === null) return 'This off-cycle run has no pay date. Create it again with one.';
  const rows = (await db`
    SELECT to_char(${runPayDateSql('h')}, 'YYYY-MM-DD') AS pay_date
      FROM payroll_run_headers h
     WHERE h.company_id = ${companyId}::uuid AND h.period_year = ${period.year} AND h.period_month = ${period.month}
       AND h.run_kind = 'regular' AND h.pay_frequency = 'monthly' AND h.status IN ('calculated', 'approved', 'paid')
       AND ${runPayDateSql('h')} <= ${payDate}::date
     ORDER BY ${runPayDateSql('h')}
     LIMIT 1
  `) as DbRow[];
  if (!rows[0]) return null;
  const closing = formatDisplayDate(String(rows[0].pay_date));
  return `This off-cycle run is paid on ${formatDisplayDate(payDate)}, on or after the month's regular run (paid ${closing}), `
    + `which has already closed the month's UIF and ETI. Pay it before ${closing}.`;
}
