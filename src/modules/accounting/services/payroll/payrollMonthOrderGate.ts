/**
 * Pay order inside one EMP201 month (wave 6 FQc, review #1575 H1). A weekly or fortnightly run's UIF reads the room
 * left under the month's ceiling after the month's EARLIER final runs, and the month's last regular run claims ETI on
 * all of them (payrollRunCadence). So, among the runs of one company, EMP201 month and pay frequency:
 *  (a) a run is not approved while an earlier run of that month (pay order, payrollRunOrder) is open: neither final nor
 *      cancelled. Approving it first would leave the earlier run to be costed after it, outside its month to date;
 *  (b) a run is not approved while a LATER run of that month is final and was calculated without this run as it now
 *      stands. PAYE_LATER_PERIODS_APPROVED does not clear this inside the month (it does across months: PAYE trues up
 *      cumulatively, a month's UIF ceiling and ETI do not): the later runs are reopened and recalculated in pay order.
 * Read-only; judged with the year-to-date gate (payrollYearToDateGate.judgeYearToDate). Null when in order.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { runOrderKeySql } from './payrollRunOrder';
import type { PayrollJournalNote } from './payrollJournalPlanTypes';

export const PAY_ORDER_IN_MONTH = 'pay_order_in_month';

export async function monthOrderRefusal(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const rows = (await sql`
    WITH runs AS (
      SELECT h.*, ${runOrderKeySql('h')} AS run_key, to_char(h.period_start, 'YYYY-MM-DD') AS label,
             ${sql.unsafe(payRunFinalSql('h'))} AS final,
             (SELECT MIN(l.created_at) FROM payroll_run_lines l WHERE l.run_id = h.id) AS lines_at
        FROM payroll_run_headers h
       WHERE h.company_id = ${companyId}::uuid
    ),
    me AS (SELECT * FROM runs WHERE id = ${runId}::uuid)
    SELECT e.label, e.run_key < me.run_key AS earlier
      FROM runs e, me
     WHERE e.id <> me.id
       AND e.period_year = me.period_year AND e.period_month = me.period_month AND e.pay_frequency = me.pay_frequency
       AND e.status <> 'cancelled'
       AND CASE WHEN e.run_key < me.run_key THEN NOT e.final
                ELSE e.final AND NOT (
                  me.lines_at <= e.lines_at
                  AND COALESCE(me.approval_history @> e.lines_at, false)) END
     ORDER BY e.run_key
  `) as DbRow[];
  if (rows.length === 0) return null;
  const earlier = rows.filter((r) => r.earlier === true).map((r) => String(r.label));
  const later = rows.filter((r) => r.earlier !== true).map((r) => String(r.label));
  return {
    code: PAY_ORDER_IN_MONTH,
    detail: earlier.length > 0
      ? `An earlier run of this month (${earlier.join(', ')}) is not approved. A month's UIF ceiling and ETI are worked out over `
        + 'its runs in pay order, so approve that run first, then recalculate this one and approve it.'
      : `A later run of this month (${later.join(', ')}) is approved and was calculated without this run as it now stands, so `
        + 'the month\'s UIF ceiling and ETI did not count it. Reopen the later runs, approve this one, then recalculate and '
        + 'approve the later runs in pay order.',
  };
}
