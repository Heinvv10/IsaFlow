/**
 * The ETI carry's reads (wave 5 ET): PAYE and ETI by month from the run headers and the stand-alone directive payments,
 * company-scoped, over any range of months (`loadEtiMonths`, the one monthly sum). The ledger itself is etiCarry.ts.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { listStandaloneDirectivePayments } from './directivePaymentFiling';
import { payrollJournalInForce } from './payrollJournalChain';
import {
  etiCarryLedger, etiMonthsOf, index, reconciliationStart, type EtiCarryMonth, type EtiMonth, type YearMonth,
} from './etiCarry';

const pad = (n: number): string => String(n).padStart(2, '0');
export const firstOf = (ym: YearMonth): string => `${ym.year}-${pad(ym.month)}-01`;
export const lastOf = (ym: YearMonth): string => new Date(Date.UTC(ym.year, ym.month, 0)).toISOString().slice(0, 10);
const fromIndex = (i: number): YearMonth => ({ year: Math.floor(i / 12), month: (i % 12) + 1 });

/**
 * Which runs a month's sum counts:
 *  - 'declarable': approved or paid headers, what the EMP201 declares;
 *  - 'inForceJournal': headers whose journal is in force (payrollJournalChain), what the ledger has booked;
 *  - 'none': no runs (the caller adds its own).
 */
export type RunBasis = 'declarable' | 'inForceJournal' | 'none';

/** PAYE and ETI by month for `from`..`to` (inclusive): the runs on `basis`, and every in-force stand-alone directive. */
export async function loadEtiMonths(companyId: string, from: YearMonth, to: YearMonth, basis: RunBasis = 'declarable'): Promise<EtiMonth[]> {
  if (index(to) < index(from)) return [];
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = basis === 'none' ? [] : (await sql`
    SELECT period_year, period_month, total_paye AS paye, total_eti AS eti, status, journal_entry_id
      FROM payroll_run_headers
     WHERE company_id = ${companyId}::uuid
       AND make_date(period_year, period_month, 1) >= ${firstOf(from)}::date
       AND make_date(period_year, period_month, 1) <= ${firstOf(to)}::date
  `) as DbRow[];
  const runs: DbRow[] = [];
  for (const r of rows) {
    const counted = basis === 'declarable'
      ? declarable.includes(String(r.status))
      : r.journal_entry_id != null && await payrollJournalInForce(companyId, String(r.journal_entry_id));
    if (counted) runs.push(r);
  }
  const directives = await listStandaloneDirectivePayments(companyId, { start: firstOf(from), end: lastOf(to) });
  return etiMonthsOf(runs, directives);
}

/** PAYE and ETI of the months of `from`'s reconciliation period before `from` (declared); none when `from` starts it. */
export async function loadEarlierEtiMonths(companyId: string, from: YearMonth): Promise<EtiMonth[]> {
  const start = reconciliationStart(from);
  return index(start) === index(from) ? [] : loadEtiMonths(companyId, start, fromIndex(index(from) - 1));
}

const lineOf = (ym: YearMonth, months: EtiMonth[]): EtiCarryMonth =>
  etiCarryLedger(ym, ym, months).find((m) => index(m) === index(ym))!;

/**
 * One month's ledger line for a run's journal: the earlier months, this month's stand-alone directive PAYE, and the run
 * itself (one run per company per month). `used` is the ETI the EMP201 uses against the month's whole PAYE (directives
 * included, guide §6.1 p. 42), so the journals' net 2140 credit for the month is the EMP201 PAYE payable.
 */
export async function etiMonthForRun(companyId: string, ym: YearMonth, run: { paye: number; eti: number }): Promise<EtiCarryMonth> {
  return lineOf(ym, [...await loadEarlierEtiMonths(companyId, ym), ...await loadEtiMonths(companyId, ym, ym, 'none'), { ...ym, ...run }]);
}

/**
 * One month's ledger line for a directive's ETI journal: the earlier months as declared, this month's directives, and
 * this month's run ONLY through its in-force journal (coordinator choice for review M2): an approved run whose journal
 * is not in force books its own ETI when it posts, so nothing here counts it twice or books it early.
 */
export async function etiMonthLine(companyId: string, ym: YearMonth): Promise<EtiCarryMonth> {
  return lineOf(ym, [...await loadEarlierEtiMonths(companyId, ym), ...await loadEtiMonths(companyId, ym, ym, 'inForceJournal')]);
}
