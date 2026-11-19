/**
 * One SDL decision per month (wave 6 FQb1, review #1507). The levy is due, or not, for the employer's month as a whole
 * (SDLA s4(b): the R500 000 annual estimate, sdlLeviabilityService.estimateAnnualRemuneration, which counts every
 * calculated, approved or paid run of the month). Each run stores the decision it was costed on (sdl_exempt); a run
 * costed before another run of its month existed, or before one was cancelled, decided on a different month.
 *
 * At approval the month is re-judged ONCE, now, on the stored runs (the same estimate, this run's own stored figure).
 * Every calculated or approved run of the month whose stored decision differs from that fresh one is stale, and the
 * approval is refused, before any write, naming each stale run and what clears it: recalculate it (this run, or a
 * calculated one), or reopen and recalculate it (approved). Recalculating converges: a recalculation costs on the same
 * month total the gate judged. This release has no run-cancel path; whoever adds one must re-judge the month (a
 * cancelled run leaves the month's other runs costed on a total that no longer holds; this gate then refuses them).
 *
 * A PAID run is final (legacy only: no code writes 'paid'): it is never named as stale and never blocks; if its stored
 * decision differs, its SDL is corrected outside IsaFlow (an EMP201 correction), as for any paid month.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import { estimateAnnualRemuneration } from './sdlLeviabilityService';
import { isSdlExempt } from './sdlEngine';
import { getTaxYear } from './taxTables';

const side = (exempt: boolean) => (exempt ? 'below the R500 000 SDL threshold (exempt)' : 'liable for SDL');

/** The stale runs of this run's month (stored SDL decision differs from the month judged now); null when none. */
export async function sdlMonthSplitRefusal(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const runs = (await sql`
    SELECT o.id, o.status, o.run_kind, o.period_year, o.period_month, (o.id = ${runId}::uuid) AS is_this,
           (SELECT bool_or(l.sdl_exempt) FROM payroll_run_lines l WHERE l.run_id = o.id) AS stored
      FROM payroll_run_headers me
      JOIN payroll_run_headers o ON o.company_id = me.company_id AND o.period_year = me.period_year AND o.period_month = me.period_month
     WHERE me.id = ${runId}::uuid AND me.company_id = ${companyId}::uuid
       AND (o.id = me.id OR o.status IN ('calculated', 'approved', 'paid'))
     ORDER BY o.created_at, o.id
  `) as DbRow[];
  const me = runs.find((r) => r.is_this === true);
  if (!me || !runs.some((r) => r.stored != null)) return null;
  const period = { year: Number(me.period_year), month: Number(me.period_month) };
  const fresh = isSdlExempt(await estimateAnnualRemuneration(companyId, period, 'stored', runId), getTaxYear(period.month, period.year));
  const stale = runs.filter((r) => r.stored != null && r.stored !== fresh && r.status !== 'paid');
  if (stale.length === 0) return null;
  const month = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const steps = stale.map((r) => (r.is_this === true
    ? 'recalculate this run'
    : `${r.status === 'approved' ? 'reopen and recalculate' : 'recalculate'} the ${String(r.run_kind)} run ${String(r.id)} `
      + `(${String(r.status)})`));
  return {
    code: 'sdl_month_split',
    detail: `SDL is decided for the month as a whole (SDLA s4(b)): ${month}, judged now on its runs, is ${side(fresh)}, `
      + `but ${stale.length === 1 ? 'a run was' : `${stale.length} runs were`} costed the other way. To approve: ${steps.join('; ')}.`,
  };
}
