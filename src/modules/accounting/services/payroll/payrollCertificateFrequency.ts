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
import { formatDayRange } from './payrollPayWeek';

export async function assertCertificateYearMonthlyOnly(companyId: string, taxYear: number): Promise<void> {
  const rows = (await sql`
    SELECT h.pay_frequency, to_char(h.period_start, 'YYYY-MM-DD') AS start, to_char(h.period_end, 'YYYY-MM-DD') AS stop
      FROM payroll_run_headers h
     WHERE h.company_id = ${companyId}::uuid AND ${sql.unsafe(payRunFinalSql('h'))} AND h.pay_frequency <> 'monthly'
       AND make_date(h.period_year, h.period_month, 1) BETWEEN make_date(${taxYear - 1}::int, 3, 1) AND make_date(${taxYear}::int, 2, 1)
     ORDER BY h.period_start
  `) as DbRow[];
  if (rows.length === 0) return;
  const first = rows[0]!;
  throw new RunKindUnsupportedError('irp5', [{
    clause: 'frequency',
    detail: `tax year ${taxYear} has ${rows.length} approved weekly or fortnightly run${rows.length > 1 ? 's' : ''} (the first: the `
      + `${String(first.pay_frequency)} run for ${formatDayRange(String(first.start), String(first.stop))}), and IRP5 and EMP501 `
      + 'certificates cover monthly runs only in this release',
  }]);
}
