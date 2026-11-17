import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { getTaxYear } from './taxTables';
import type { PayrollPeriod, ValidationResult } from './payrollTypes';

/**
 * The warnings for a run calculated while LATER periods of its tax year are
 * already approved or paid (a month back-filled, or reopened and corrected),
 * by employee: only an employee paid in those later runs, whose PAYE there was
 * calculated without this month. The cumulative method trues it up only in the
 * next period calculated after them; if February is among them, nothing does
 * (IsaFlow has no PAYE adjustment), so it stays short until the assessment.
 */
export async function laterPeriodsWarnings(
  companyId: string,
  runId: string,
  period: PayrollPeriod,
): Promise<Map<string, ValidationResult>> {
  const taxYear = getTaxYear(period.month, period.year);
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    SELECT l.employee_id, h.period_year, h.period_month
    FROM payroll_run_headers h
    JOIN payroll_run_lines l ON l.run_id = h.id
    WHERE h.company_id = ${companyId}::uuid AND h.id <> ${runId}::uuid
      AND h.status = ANY(${declarable}::text[])
      AND make_date(h.period_year, h.period_month, 1) > make_date(${period.year}::int, ${period.month}::int, 1)
      AND make_date(h.period_year, h.period_month, 1) <= make_date(${taxYear}::int, 2, 1)
    ORDER BY l.employee_id, h.period_year, h.period_month
  `) as DbRow[];
  const months = new Map<string, string[]>();
  for (const r of rows) {
    const key = String(r.employee_id);
    const list = months.get(key) ?? [];
    list.push(`${String(r.period_year)}-${String(r.period_month).padStart(2, '0')}`);
    months.set(key, list);
  }
  // `periods` is what judgeYearToDateStale matches on; the message is for people.
  return new Map([...months].map(([employee, list]) => [employee, {
    code: 'PAYE_LATER_PERIODS_APPROVED',
    severity: 'warning' as const,
    periods: list,
    message: `Later runs of this tax year that pay this employee are already approved (${list.join(', ')}). PAYE is cumulative over `
      + 'the year, so their PAYE did not include this month: the next run calculated after them corrects it. If February is '
      + 'among them, nothing follows and IsaFlow has no PAYE adjustment: the difference stays until the employee\'s assessment, '
      + 'unless those runs are reopened and recalculated in order.',
  }]));
}
