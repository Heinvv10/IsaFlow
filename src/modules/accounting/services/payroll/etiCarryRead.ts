/**
 * The ETI carry's reads (wave 5 ET): the earlier months of a reconciliation period, and one month's ledger line, from the
 * declarable run headers and the stand-alone directive payments, company-scoped. The ledger itself is etiCarry.ts.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { listStandaloneDirectivePayments } from './directivePaymentFiling';
import {
  etiCarryLedger, etiMonthsOf, index, reconciliationStart, type EtiCarryMonth, type EtiMonth, type YearMonth,
} from './etiCarry';

const pad = (n: number): string => String(n).padStart(2, '0');
const firstOf = (ym: YearMonth): string => `${ym.year}-${pad(ym.month)}-01`;
const lastOf = (ym: YearMonth): string => new Date(Date.UTC(ym.year, ym.month, 0)).toISOString().slice(0, 10);

/** PAYE and ETI of the months of `from`'s reconciliation period before `from`; none when `from` starts the period. */
export async function loadEarlierEtiMonths(companyId: string, from: YearMonth): Promise<EtiMonth[]> {
  const start = reconciliationStart(from);
  if (index(start) === index(from)) return [];
  const startDate = firstOf(start);
  const fromDate = firstOf(from);
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    SELECT period_year, period_month, SUM(total_paye) AS paye, SUM(total_eti) AS eti
      FROM payroll_run_headers
     WHERE company_id = ${companyId}::uuid
       AND status = ANY(${declarable}::text[])
       AND make_date(period_year, period_month, 1) >= ${startDate}::date
       AND make_date(period_year, period_month, 1) < ${fromDate}::date
     GROUP BY period_year, period_month
  `) as DbRow[];
  const dayBefore = new Date(Date.UTC(from.year, from.month - 1, 0)).toISOString().slice(0, 10);
  const directives = await listStandaloneDirectivePayments(companyId, { start: startDate, end: dayBefore });
  return etiMonthsOf(rows, directives);
}

/**
 * One month's ledger line for a run's journal: the earlier months, this month's stand-alone directive PAYE, and the run
 * itself (one run per company per month). `used` is the ETI the EMP201 uses against the month's whole PAYE (directives
 * included, guide §6.1 p. 42), so the journals' net 2140 credit for the month is the EMP201 PAYE payable.
 */
export async function etiMonthForRun(companyId: string, ym: YearMonth, run: { paye: number; eti: number }): Promise<EtiCarryMonth> {
  const earlier = await loadEarlierEtiMonths(companyId, ym);
  const directives = await listStandaloneDirectivePayments(companyId, { start: firstOf(ym), end: lastOf(ym) });
  const months: EtiMonth[] = [...earlier, ...etiMonthsOf([], directives), { ...ym, ...run }];
  return etiCarryLedger(ym, ym, months).find((m) => index(m) === index(ym))!;
}
