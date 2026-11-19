import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { getTaxYear } from './taxTables';
import { runIsBeforeSql, runOrderKeySql } from './payrollRunOrder';
import type { PayrollPeriod, ValidationResult } from './payrollTypes';

/**
 * The warnings for a run calculated while LATER runs of its tax year are already approved or paid (a period
 * back-filled, or reopened and corrected), by employee: only an employee paid in those later runs, whose PAYE there was
 * calculated without this run. The cumulative method trues it up only in the next run calculated after them; if the
 * year's last is among them, nothing does (IsaFlow has no PAYE adjustment), so it stays short until the assessment.
 *
 * "Later" is in pay order (payrollRunOrder; wave 6 FQc, carried from #1507 review B2b): a later weekly run of the same
 * month is later. The warning names the runs by id (`runs`, what the approval gate matches) and, for people, by period
 * (`periods`: a monthly regular run's YYYY-MM, as before; any other run's period start, YYYY-MM-DD).
 */
export async function laterPeriodsWarnings(
  companyId: string,
  runId: string,
  period: PayrollPeriod,
): Promise<Map<string, ValidationResult>> {
  const taxYear = getTaxYear(period.month, period.year);
  const rows = (await sql`
    SELECT l.employee_id, h.id::text AS run_id,
           CASE WHEN h.pay_frequency = 'monthly' AND h.run_kind = 'regular'
                THEN to_char(make_date(h.period_year, h.period_month, 1), 'YYYY-MM')
                ELSE to_char(h.period_start, 'YYYY-MM-DD') END AS label
    FROM payroll_run_headers h
    JOIN payroll_run_lines l ON l.run_id = h.id
    WHERE h.company_id = ${companyId}::uuid AND h.id <> ${runId}::uuid
      AND ${sql.unsafe(payRunFinalSql('h'))}
      AND NOT ${runIsBeforeSql('h', companyId, runId)}
      AND make_date(h.period_year, h.period_month, 1) <= make_date(${taxYear}::int, 2, 1)
    ORDER BY l.employee_id, ${runOrderKeySql('h')}
  `) as DbRow[];
  const later = new Map<string, { runs: string[]; periods: string[] }>();
  for (const r of rows) {
    const key = String(r.employee_id);
    const entry = later.get(key) ?? { runs: [], periods: [] };
    entry.runs.push(String(r.run_id));
    entry.periods.push(String(r.label));
    later.set(key, entry);
  }
  // `runs` is what judgeYearToDate matches on; `periods` and the message are for people.
  return new Map([...later].map(([employee, { runs, periods }]) => [employee, {
    code: 'PAYE_LATER_PERIODS_APPROVED',
    severity: 'warning' as const,
    periods,
    runs,
    message: `Later runs of this tax year that pay this employee are already approved (${periods.join(', ')}). PAYE is cumulative over `
      + 'the year, so their PAYE did not include this run: the next run calculated after them corrects it. If the year\'s last '
      + 'run is among them, nothing follows and IsaFlow has no PAYE adjustment: the difference stays until the employee\'s '
      + 'assessment, unless those runs are reopened and recalculated in order.',
  }]));
}
