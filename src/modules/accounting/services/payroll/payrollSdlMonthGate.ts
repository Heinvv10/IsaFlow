/**
 * The SDL of a run, re-judged at approval (wave 6 FQb1, review #1507; reshaped by OC, review #1620 final breaker H).
 * SDL is a month-to-date catch-up (payrollSdlMonthToDate): a run's levy depends on its month's estimate and on the
 * month's earlier FINAL runs. A run calculated before another run of its month became final (or was cancelled, or
 * reopened) may have been costed on a month that no longer holds. At approval this run's own lines are re-costed, now,
 * on the stored figures (the same estimate, sdlLeviabilityService.estimateAnnualRemuneration with 'stored'; the same
 * earlier final runs), and if any line's SDL or decision differs, the approval is refused, before any write: recalculate
 * this run. Only THIS run is ever named: an earlier final run keeps what it levied, and nothing is reopened for SDL
 * (a later run carries what it did not levy).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { PayrollJournalNote } from './payrollJournalBuilder';
import { applySdlToLines, estimateAnnualRemuneration, type SdlLine } from './sdlLeviabilityService';
import { loadMonthToDateSdl } from './payrollSdlMonthToDate';
import { getTaxYear } from './taxTables';
import { formatMoney } from '@/lib/money/formatMoney';

const cents = (n: number): number => Math.round(n * 100);

/** This run's SDL no longer matches its month as it stands now; null when it does (or nothing is stored yet). */
export async function sdlMonthSplitRefusal(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const rows = (await sql`
    SELECT h.period_year, h.period_month, l.employee_id::text AS employee_id, l.sdl_leviable, l.sdl, l.sdl_exempt
      FROM payroll_run_headers h JOIN payroll_run_lines l ON l.run_id = h.id
     WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
  `) as DbRow[];
  if (rows.length === 0 || rows.every((r) => r.sdl_exempt == null)) return null;
  const period = { year: Number(rows[0]!.period_year), month: Number(rows[0]!.period_month) };
  const lines: SdlLine[] = rows.map((r) => ({ sdl: 0, sdlLeviable: Number(r.sdl_leviable) || 0, employeeId: String(r.employee_id) }));
  const estimate = await estimateAnnualRemuneration(companyId, period, 'stored', runId);
  applySdlToLines(lines, estimate, getTaxYear(period.month, period.year), await loadMonthToDateSdl(companyId, runId));
  const stale = rows.filter((r, i) => r.sdl_exempt !== lines[i]!.sdlExempt || cents(Number(r.sdl)) !== cents(lines[i]!.sdl));
  if (stale.length === 0) return null;
  const stored = rows.reduce((t, r) => t + Number(r.sdl), 0);
  const now = lines.reduce((t, l) => t + l.sdl, 0);
  const month = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const side = (exempt: unknown) => (exempt === true ? 'exempt' : 'liable');
  return {
    code: 'sdl_month_split',
    detail: `SDL is settled for the month to date (SDLA s4(b)): ${month}, judged now on its runs, puts ${formatMoney(now)} of SDL on this run `
      + `(${side(lines[0]!.sdlExempt)}), but it was costed with ${formatMoney(stored)} (${side(rows[0]!.sdl_exempt)}). To approve: recalculate this run.`,
  };
}
