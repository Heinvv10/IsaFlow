/**
 * SDL at approval (wave 6 FQd, review #1622, coordinator ruling: the month-to-date catch-up replaces FQb1's one decision
 * per month and its sdl_month_split refusal). Each run's SDL is judged at calculate on the month to date
 * (sdlLeviabilityService.sdlCatchUp): liable once any run of the month is, and catching up the 1% the month's earlier
 * final runs left uncharged. No run is ever sent back to reopen for SDL: an approved run's SDL stands, and a later run
 * of the month catches up on it.
 *
 * What can still be stale is THIS run: another run of the month approved (or recalculated) after this one was costed
 * changes this run's catch-up. At approval this run's SDL is re-judged now on its stored lines; when it differs from what
 * it stores, the approval is refused before any write, naming the fix: recalculate this run (code sdl_recalculate).
 * Recalculating converges, since it costs on exactly what was judged.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import { estimateAnnualRemuneration, lineSdlShares, sdlCatchUp } from './sdlLeviabilityService';
import { isSdlExempt } from './sdlEngine';
import { getTaxYear } from './taxTables';
import { formatMoney } from '@/lib/money/formatMoney';

/** This run's SDL, re-judged on the month as it stands now, when it differs from what the run stores; null otherwise. */
export async function sdlRecalculateRefusal(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const head = ((await sql`
    SELECT period_year, period_month, status FROM payroll_run_headers WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  if (!head || head.status === 'paid') return null;
  const lines = (await sql`
    SELECT COALESCE(sdl_leviable, 0)::float8 AS leviable, sdl::float8 AS sdl, sdl_exempt
      FROM payroll_run_lines WHERE run_id = ${runId}::uuid ORDER BY id
  `) as DbRow[];
  if (lines.length === 0 || lines.every((l) => l.sdl_exempt == null)) return null;
  const period = { year: Number(head.period_year), month: Number(head.period_month) };
  const annual = await estimateAnnualRemuneration(companyId, period, 'stored', runId);
  const up = await sdlCatchUp(companyId, runId, !isSdlExempt(annual, getTaxYear(period.month, period.year)));
  const fresh = lineSdlShares(lines.map((l) => Number(l.leviable)), up);
  const stored = lines.map((l) => Number(l.sdl));
  const sum = (v: number[]) => Math.round(v.reduce((a, b) => a + b, 0) * 100) / 100;
  // The run's total and the month's decision (a cent the catch-up places on one of two equal lines is the same SDL).
  if (Math.abs(sum(fresh) - sum(stored)) < 0.005 && lines.every((l) => l.sdl_exempt === !up.liable)) return null;
  return {
    code: 'sdl_recalculate',
    detail: `The month's SDL has moved since this run was calculated (another run of the month was approved or recalculated): `
      + `this run now carries ${formatMoney(sum(fresh))} SDL, not ${formatMoney(sum(stored))}. Recalculate this run, then approve it.`,
  };
}
