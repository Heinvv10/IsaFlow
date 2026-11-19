/**
 * The month order an off-cycle run keeps (wave 6 OC, review #1620), each judged before any write:
 *
 *  - Pay order is creation order (breaker H2): a new off-cycle run is paid AFTER every non-cancelled off-cycle run
 *    already in its month. runOrderKeySql orders a month's off-cycle runs by pay date, and a run is costed on the
 *    final runs before it (payrollOffCycleMonthRead), so a run slotted in before an approved one would share its UIF
 *    room and ETI. A run on the same pay date is refused too (no tie is left to break).
 *  - No later month is final (breaker, bonus-after-later-month): a later month's approved run carries a PAYE year to
 *    date that would miss this run. Reopen it first. Judged within the tax year (March to February).
 *  - Approval (offCycleApprovalRefusal, live approve, the approval preview and the R-035 submit): the pay date has not
 *    passed (D1), the run pays something (UI review L4), the month's earlier runs stand as it was costed on them
 *    (offCycleBasisRefusal, review #1620 M1), and no later month is final.
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { formatDisplayDate } from '@/utils/dateFormat';
import { payRunFinalSql } from './payRunFinalSql';
import { runPayDateSql } from './payrollRunOrder';
import { offCycleBasisRefusal, offCyclePayDateRefusal } from './payrollOffCycleGates';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (year: number, month: number) => `${MONTHS[month - 1]} ${year}`;

/** An off-cycle run with no gross pay: nothing to submit or approve (UI review #1620 L4). */
export const ZERO_GROSS = 'This off-cycle run pays nothing (total gross R0.00), so there is nothing to approve. Calculate it again, or cancel it.';

/** Why a new off-cycle run of `period` paid on `payDate` would not be the month's last off-cycle run; null when it is. */
export async function offCycleOrderRefusal(
  companyId: string, period: { year: number; month: number }, payDate: string, db: TxSql = sql,
): Promise<string | null> {
  const rows = (await db`
    SELECT o.off_cycle_reason, to_char(${runPayDateSql('o')}, 'YYYY-MM-DD') AS pay_date
      FROM payroll_run_headers o
     WHERE o.company_id = ${companyId}::uuid AND o.period_year = ${period.year} AND o.period_month = ${period.month}
       AND o.run_kind = 'off_cycle' AND o.status <> 'cancelled' AND ${runPayDateSql('o')} >= ${payDate}::date
     ORDER BY ${runPayDateSql('o')} DESC
     LIMIT 1
  `) as DbRow[];
  if (!rows[0]) return null;
  const when = formatDisplayDate(String(rows[0].pay_date));
  return `${monthLabel(period.year, period.month)} already has a ${String(rows[0].off_cycle_reason)} run paid on ${when}. `
    + `A new off-cycle run must be paid after it: choose a later pay date, or cancel that run first.`;
}

/** Why an off-cycle run of `period` would be missing from an approved later month's PAYE year to date; null when not. */
export async function laterMonthFinalRefusal(
  companyId: string, period: { year: number; month: number }, db: TxSql = sql,
): Promise<string | null> {
  const taxYearEnd = period.month >= 3 ? period.year + 1 : period.year;
  const rows = (await db`
    SELECT h.period_year, h.period_month
      FROM payroll_run_headers h
     WHERE h.company_id = ${companyId}::uuid AND ${sql.unsafe(payRunFinalSql('h'))}
       AND h.period_start > (make_date(${period.year}::int, ${period.month}::int, 1) + INTERVAL '1 month - 1 day')::date
       AND h.period_start < make_date(${taxYearEnd}::int, 3, 1)
     ORDER BY h.period_start
     LIMIT 1
  `) as DbRow[];
  if (!rows[0]) return null;
  const later = monthLabel(Number(rows[0].period_year), Number(rows[0].period_month));
  return `${later}'s run is approved, and its PAYE year to date would miss this ${monthLabel(period.year, period.month)} `
    + `off-cycle run. Reopen ${later}'s run first.`;
}

/** Why this off-cycle run cannot be approved (or submitted for approval) now; null when it can, or it is not off-cycle. */
export async function offCycleApprovalRefusal(companyId: string, run: DbRow, db: TxSql = sql): Promise<string | null> {
  if (run.run_kind !== 'off_cycle') return null;
  const payDate = offCyclePayDateRefusal(run);
  if (payDate) return payDate;
  if (!(Number(run.total_gross) > 0)) return ZERO_GROSS;
  return (await offCycleBasisRefusal(companyId, run, db))
    ?? laterMonthFinalRefusal(companyId, { year: Number(run.period_year), month: Number(run.period_month) }, db);
}
