/**
 * Correcting an off-cycle run that was approved before (wave 6 OC, review #1620 final breaker M and its delta):
 *
 *  - The month's EMP201 (emp201FiledForMonth): once a finalised or filed EMP201 version, or a legacy submitted or
 *    accepted EMP201, covers the month, the filed declaration stands. An off-cycle run of that month is not reopened
 *    after its pay date (payrollOffCycleGates), and none is calculated or approved again (offCycleFiledMonthRefusal):
 *    a run reopened before the filing would otherwise be approved again outside the filed return (delta M2).
 *  - Raising a paid amount (offCycleRaisedAfterPayRefusal, delta M1): after its pay date a run's amounts were paid, so a
 *    correction may only lower them. Anything above the last approved amount is refused at the amount edit and again at
 *    approval (defence in depth for an amount changed another way); the difference is paid by a new off-cycle run.
 *    The last approved amount is kept by the 999x guard: the first amount change after a reopen stamps the amount it
 *    replaces (approved_amount, approved_as_of = the run's reopened_at). app_user cannot write either column.
 * Scoped by company_id throughout.
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { todayInSast } from '@/lib/saDateParser';
import { formatDisplayDate } from '@/utils/dateFormat';
import { formatMoney } from '@/lib/money/formatMoney';
import { dateColumnOf } from './payrollFrequency';

type RunFacts = { id?: unknown; run_kind?: unknown; run_date?: unknown; period_year?: unknown; period_month?: unknown; reopened_at?: unknown };

/** A finalised or filed EMP201 (or a legacy submitted or accepted one) covers the month. */
export async function emp201FiledForMonth(companyId: string, year: number, month: number, db: TxSql = sql): Promise<boolean> {
  const filed = (await db`
    SELECT 1 FROM tax_return_versions v
     WHERE v.company_id = ${companyId}::uuid AND v.form_type = 'EMP201' AND v.status IN ('finalised', 'filed')
       AND v.period_start <= (make_date(${year}::int, ${month}::int, 1) + INTERVAL '1 month - 1 day')::date
       AND v.period_end >= make_date(${year}::int, ${month}::int, 1)
    UNION ALL
    SELECT 1 FROM sars_submissions s
     WHERE s.company_id = ${companyId}::uuid AND s.form_type = 'EMP201' AND s.status IN ('submitted', 'accepted')
       AND s.period_start <= (make_date(${year}::int, ${month}::int, 1) + INTERVAL '1 month - 1 day')::date
       AND s.period_end >= make_date(${year}::int, ${month}::int, 1)
    LIMIT 1
  `) as DbRow[];
  return filed.length > 0;
}

/** Calculate and approve (delta M2): no off-cycle run of a month whose EMP201 is filed. Null when it is not. */
export async function offCycleFiledMonthRefusal(companyId: string, run: RunFacts, db: TxSql = sql): Promise<string | null> {
  if (run.run_kind !== 'off_cycle') return null;
  const year = Number(run.period_year);
  const month = Number(run.period_month);
  return (await emp201FiledForMonth(companyId, year, month, db))
    ? `The EMP201 for ${year}-${String(month).padStart(2, '0')} is filed, so an off-cycle run of that month is not calculated `
      + 'or approved: the filed declaration stands. A correction after filing is made outside payroll for now.'
    : null;
}

/** Each employee's last approved amount on this run, when the run was approved before and its pay date has passed. */
async function paidCaps(companyId: string, run: RunFacts, today: string, db: TxSql): Promise<Map<string, number> | null> {
  if (run.run_kind !== 'off_cycle' || run.reopened_at == null) return null;
  const payDate = dateColumnOf(run.run_date);
  if (payDate === null || payDate >= today) return null;
  const rows = (await db`
    SELECT x.employee_id::text AS employee_id,
           (CASE WHEN x.approved_as_of IS NOT DISTINCT FROM h.reopened_at THEN x.approved_amount ELSE x.amount END)::float8 AS cap
      FROM payroll_off_cycle_employees x JOIN payroll_run_headers h ON h.id = x.run_id AND h.company_id = x.company_id
     WHERE x.company_id = ${companyId}::uuid AND x.run_id = ${String(run.id)}::uuid AND x.amount IS NOT NULL
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.employee_id), Number(r.cap)]));
}

const raisedMessage = (payDate: string, cap: number) =>
  `This bonus was paid on ${formatDisplayDate(payDate)}, so its amount can't be raised after the pay date (last approved `
  + `${formatMoney(cap)}). Pay the difference in a new off-cycle run.`;

/** The amount edit (delta M1): `amount` would raise a paid amount. Null when it does not. */
export async function offCycleRaiseRefusal(
  companyId: string, run: RunFacts, employeeId: string, amount: number, db: TxSql = sql, today: string = todayInSast(),
): Promise<string | null> {
  const cap = (await paidCaps(companyId, run, today, db))?.get(employeeId);
  return cap !== undefined && amount > cap ? raisedMessage(String(dateColumnOf(run.run_date)), cap) : null;
}

/** Approval (delta M1, defence in depth): an amount of this run is above what was approved and paid. */
export async function offCycleRaisedAfterPayRefusal(
  companyId: string, run: RunFacts, db: TxSql = sql, today: string = todayInSast(),
): Promise<string | null> {
  const caps = await paidCaps(companyId, run, today, db);
  if (!caps || caps.size === 0) return null;
  const now = (await db`
    SELECT employee_id::text AS employee_id, amount::float8 AS amount FROM payroll_off_cycle_employees
     WHERE company_id = ${companyId}::uuid AND run_id = ${String(run.id)}::uuid AND amount IS NOT NULL
  `) as DbRow[];
  for (const r of now) {
    const cap = caps.get(String(r.employee_id));
    if (cap !== undefined && Number(r.amount) > cap) return raisedMessage(String(dateColumnOf(run.run_date)), cap);
  }
  return null;
}
