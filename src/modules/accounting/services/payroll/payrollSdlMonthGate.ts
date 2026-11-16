/**
 * One SDL decision per month (wave 6 FQb1, review #1507 B4b). The levy is due, or not, for the employer's month as a
 * whole (SDLA s4(b), the R500 000 annual estimate: sdlLeviabilityService.estimateAnnualRemuneration, which counts every
 * calculated, approved or paid run of the month). A run calculated before another run of its month existed decided on
 * less; approving it then would levy one run of the month and exempt the other. Refused here, before any write, until
 * the runs are recalculated on the same month total; recalculation converges because each then sees the same sum.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { PayrollJournalNote } from './payrollJournalBuilder';

/** The month's other runs whose stored SDL decision differs from this run's; null when they agree (or none decided). */
export async function sdlMonthSplitRefusal(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const rows = (await sql`
    WITH me AS (
      SELECT h.id, h.company_id, h.period_year, h.period_month,
             (SELECT bool_or(l.sdl_exempt) FROM payroll_run_lines l WHERE l.run_id = h.id) AS exempt
        FROM payroll_run_headers h
       WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
    )
    SELECT o.status, me.exempt AS mine, (SELECT bool_or(l.sdl_exempt) FROM payroll_run_lines l WHERE l.run_id = o.id) AS theirs,
           o.run_kind, me.period_year, me.period_month
      FROM me
      JOIN payroll_run_headers o ON o.company_id = me.company_id AND o.period_year = me.period_year
       AND o.period_month = me.period_month AND o.id <> me.id AND o.status IN ('calculated', 'approved', 'paid')
     ORDER BY o.created_at, o.id
  `) as DbRow[];
  const split = rows.filter((r) => r.mine != null && r.theirs != null && r.mine !== r.theirs);
  if (split.length === 0) return null;
  const month = `${String(split[0]!.period_year)}-${String(split[0]!.period_month).padStart(2, '0')}`;
  const side = (exempt: unknown) => (exempt === true ? 'below the R500 000 SDL threshold (exempt)' : 'liable for SDL');
  const approved = split.filter((r) => r.status === 'approved' || r.status === 'paid');
  return {
    code: 'sdl_month_split',
    detail: `Another pay run of ${month} (${split.map((r) => `${String(r.run_kind)} run, ${String(r.status)}`).join('; ')}) was judged `
      + `${side(split[0]!.theirs)}, but this run was judged ${side(split[0]!.mine)}: SDL is decided for the month as a whole `
      + '(SDLA s4(b)). Recalculate this run so both read the same month total, then approve it.'
      + (approved.length > 0 ? ' The other run is already approved: reopen it and recalculate it too.' : ''),
  };
}
