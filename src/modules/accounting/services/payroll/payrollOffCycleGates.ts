/**
 * The two judgements an off-cycle run adds to approval and reopen (wave 6 OC), each before any write.
 *
 *  - Approval: an off-cycle run is not approved after its pay date (run_date earlier than the approval day in South
 *    Africa). A run approved after the day it says it was paid is a payment nobody has made yet dated in the past:
 *    the owner cash position (ownerCashPosition, FQb2 #1549) treats a run whose pay date has passed as paid, so the
 *    bonus would leave the forecast unpaid (review #1549 delta-2 D1). Move the pay date by creating the run again.
 *  - Reopen of a REGULAR run: refused while a final off-cycle run of its month and frequency exists. The off-cycle
 *    line's PAYE, UIF and ETI were costed on this run's line (the month's annual equivalent, the month's UIF cap and
 *    ETI), so changing it would leave those figures wrong. Reopen the off-cycle run first.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { todayInSast } from '@/lib/saDateParser';
import { payRunFinalSql } from './payRunFinalSql';
import { dateColumnOf } from './payrollFrequency';

/** Why this off-cycle run cannot be approved today; null when it can (or it is not off-cycle). */
export function offCyclePayDateRefusal(run: { run_kind?: unknown; run_date?: unknown }, today: string = todayInSast()): string | null {
  if (run.run_kind !== 'off_cycle') return null;
  const payDate = dateColumnOf(run.run_date);
  if (payDate === null) return 'This off-cycle run has no pay date. Create it again with one.';
  return payDate < today
    ? `This off-cycle run's pay date (${payDate}) is before today (${today}): it cannot be approved after the day it says it was paid. `
      + 'Create the run again with a pay date of today or later.'
    : null;
}

/** Why this regular run cannot be reopened (a final off-cycle run of its month rests on it); null when it can. */
export async function laterOffCycleRefusal(companyId: string, runId: string): Promise<string | null> {
  const rows = (await sql`
    SELECT o.id, o.off_cycle_reason
      FROM payroll_run_headers me
      JOIN payroll_run_headers o
        ON o.company_id = me.company_id AND o.period_year = me.period_year AND o.period_month = me.period_month
       AND o.pay_frequency = me.pay_frequency AND o.run_kind = 'off_cycle'
     WHERE me.id = ${runId}::uuid AND me.company_id = ${companyId}::uuid AND me.run_kind = 'regular'
       AND ${sql.unsafe(payRunFinalSql('o'))}
     ORDER BY o.created_at, o.id
  `) as DbRow[];
  if (rows.length === 0) return null;
  const runs = rows.map((r) => `the ${String(r.off_cycle_reason)} run ${String(r.id)}`).join(', ');
  return `This month's approved off-cycle runs were costed on this run's lines (${runs}). Reopen ${rows.length === 1 ? 'it' : 'them'} first.`;
}
