/**
 * The pay-frequency writer's own check (wave 6 FQd; payrollEmployeePayFrequency), beside FQc's shared rules
 * (payrollFrequencyGuard: the mid-year rule, the terms). Split from payrollFrequencyGuard (file-size cap).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { PayFrequencyRefusedError, refuseMixedFrequencyYear } from './payrollFrequencyGuard';
import { employeeName } from './payrollFrequencyStraddle';
import { formatDayRange } from './payrollPayWeek';
import { getTaxYear } from './taxTables';
import type { PayFrequency } from './payrollTypes';

/**
 * For the writer of payroll_employees.pay_frequency (FQd): refused (409) when the employee already has a final line this
 * tax year at another frequency (the run's EMP201 month places it: a week paid in February is last year's), or when a
 * run of another frequency NOT yet final pays them on or after the new frequency's first day: the day after the old
 * frequency's last final day, else the change date's month (breaker #1622 M2). A final run straddling that day is not
 * refused here: the new frequency's first run is (payrollFrequencyStraddle). `asAt`: when the change takes effect.
 */
export async function assertFrequencyChangeAllowed(companyId: string, employeeId: string, to: PayFrequency, asAt: string): Promise<void> {
  const month = Number(asAt.slice(5, 7));
  const year = Number(asAt.slice(0, 4));
  await refuseMixedFrequencyYear(companyId, to, getTaxYear(month, year), [employeeId]);
  const rows = (await sql`
    WITH first_day AS (
      SELECT COALESCE((
        SELECT max(h.period_end) + 1 FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id
         WHERE h.company_id = ${companyId}::uuid AND l.employee_id = ${employeeId}::uuid AND h.pay_frequency <> ${to}
           AND ${sql.unsafe(payRunFinalSql('h'))}
      ), make_date(${year}::int, ${month}::int, 1)) AS d
    )
    SELECT e.first_name, e.last_name, h.pay_frequency, to_char(h.period_start, 'YYYY-MM-DD') AS start, to_char(h.period_end, 'YYYY-MM-DD') AS stop
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
      JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
     WHERE h.company_id = ${companyId}::uuid AND l.employee_id = ${employeeId}::uuid AND h.pay_frequency <> ${to}
       AND h.status <> 'cancelled' AND NOT ${sql.unsafe(payRunFinalSql('h'))}
       AND h.period_end >= (SELECT d FROM first_day)
     ORDER BY h.period_start
  `) as DbRow[];
  if (rows.length === 0) return;
  const name = employeeName(rows[0]!);
  throw new PayFrequencyRefusedError(409, rows.map((r) => ({ clause: 'pay_period_overlap' as const,
    detail: `${name} is already paid for ${formatDayRange(String(r.start), String(r.stop))} on the ${String(r.pay_frequency)} run, which is `
      + `not approved yet. Changing ${name} to ${to} would pay those days twice: approve or delete that run first.` })), 'PAY_PERIOD_OVERLAP', true);
}
