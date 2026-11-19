/**
 * IRP5 and EMP501 certificates are monthly-only this wave (coordinator, #1622 x EFb #1568; breaker #1622 M-D): every
 * certificate route and service (the IRP5 data and summary, the e@syFile export, the EMP501 export, reconciliation and
 * summary, the IRP5 pre-validation) asks this first. A tax year with any FINAL weekly or fortnightly run is refused by
 * name (RunKindUnsupportedError 'irp5', answered 409 RUN_KIND_UNSUPPORTED by the shared run responder), before anything
 * is read for the certificate. Weekly EMP501/IRP5 is wave 7, before the 2027 annual submission.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { RunKindUnsupportedError } from './payrollRunKindGuard';
import { formatDayRange, formatMonth } from './payrollPayWeek';

/**
 * `throughMonth` (YYYYMM; breaker #1622 L-G): a return covering part of the year judges its own months only. The
 * INTERIM EMP501 (March to August) passes August, so a company that starts paying weekly in September still files its
 * interim; the annual, the IRP5 and every other caller judge the whole year.
 */
export async function assertCertificateYearMonthlyOnly(companyId: string, taxYear: number, throughMonth?: number): Promise<void> {
  const through = Math.min(throughMonth ?? taxYear * 100 + 2, taxYear * 100 + 2);
  const lastYear = Math.floor(through / 100);
  const lastMonth = through % 100;
  const partial = through < taxYear * 100 + 2;
  const rows = (await sql`
    SELECT h.pay_frequency, to_char(h.period_start, 'YYYY-MM-DD') AS start, to_char(h.period_end, 'YYYY-MM-DD') AS stop
      FROM payroll_run_headers h
     WHERE h.company_id = ${companyId}::uuid AND ${sql.unsafe(payRunFinalSql('h'))} AND h.pay_frequency <> 'monthly'
       AND make_date(h.period_year, h.period_month, 1) BETWEEN make_date(${taxYear - 1}::int, 3, 1) AND make_date(${lastYear}::int, ${lastMonth}::int, 1)
     ORDER BY h.period_start
  `) as DbRow[];
  if (rows.length === 0) return;
  const first = rows[0]!;
  throw new RunKindUnsupportedError('irp5', [{
    clause: 'frequency',
    detail: `${partial ? `tax year ${taxYear} up to ${formatMonth(lastYear, lastMonth)}` : `tax year ${taxYear}`} has ${rows.length} approved weekly or fortnightly run${rows.length > 1 ? 's' : ''} (the first: the `
      + `${String(first.pay_frequency)} run for ${formatDayRange(String(first.start), String(first.stop))}), and IRP5 and EMP501 `
      + 'certificates cover monthly runs only in this release',
  }]);
}
