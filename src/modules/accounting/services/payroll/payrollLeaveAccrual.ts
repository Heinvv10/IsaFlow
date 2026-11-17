/**
 * Payroll leave accrual and year rollover (moved out of payrollLeaveService.ts, which re-exports them).
 */
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import {
  computeExpectedAccrual,
  computeCarryOver,
  endOfMonthIso,
  type AccrualRule,
} from '@/modules/accounting/services/payroll/leaveAccrualService';

export interface AccrualResult {
  updated: number;
  skipped: number;
}

/**
 * Advance payroll_leave_balances.accrued for every (active employee × active
 * leave type whose accrual_rule != 'none') to the expected value as at the end
 * of `year/month`. Idempotent: accrued is only raised to max(current, expected),
 * so re-running doesn't double-count.
 */
export async function runMonthlyAccrual(
  companyId: string,
  year: number,
  month: number,
): Promise<AccrualResult> {
  if (month < 1 || month > 12) throw new Error('month must be 1..12');
  const asOf = endOfMonthIso(year, month);
  const yearStart = `${year}-01-01`;

  const employees = (await sql`
    SELECT id, start_date, end_date
    FROM   payroll_employees
    WHERE  company_id = ${companyId}::uuid
      AND  status = 'active'
  `) as DbRow[];

  const leaveTypes = (await sql`
    SELECT id, accrual_rule, accrual_days
    FROM   payroll_leave_types
    WHERE  company_id = ${companyId}::uuid
      AND  is_active = TRUE
      AND  accrual_rule <> 'none'
  `) as DbRow[];

  let updated = 0;
  let skipped = 0;

  for (const emp of employees) {
    const startIso = fmtDate(emp.start_date);
    const endIso = emp.end_date ? fmtDate(emp.end_date) : null;

    for (const lt of leaveTypes) {
      const expected = computeExpectedAccrual({
        employeeStart: startIso,
        employeeEnd: endIso,
        asOf,
        yearStart,
        accrualRule: String(lt.accrual_rule) as AccrualRule,
        accrualDays: Number(lt.accrual_days),
      });

      // Two-step to keep portability: read prior balance, then upsert. The
      // previous version referenced EXCLUDED in a RETURNING subquery, which
      // Postgres rejects ("invalid reference to FROM-clause entry for table
      // excluded") — EXCLUDED is only visible in the DO UPDATE SET clause.
      const priorRows = await sql`
        SELECT accrued FROM payroll_leave_balances
         WHERE employee_id = ${emp.id as string}::uuid
           AND leave_type_id = ${lt.id as string}::uuid
           AND balance_year = ${year}
         LIMIT 1
      ` as DbRow[];
      const priorAccrued = priorRows[0]?.accrued == null ? null : Number(priorRows[0]!.accrued);

      await sql`
        INSERT INTO payroll_leave_balances
          (company_id, employee_id, leave_type_id, balance_year, accrued, taken, pending)
        VALUES
          (${companyId}::uuid, ${emp.id as string}::uuid, ${lt.id as string}::uuid, ${year}, ${expected}, 0, 0)
        ON CONFLICT (employee_id, leave_type_id, balance_year) DO UPDATE
          SET accrued = GREATEST(payroll_leave_balances.accrued, EXCLUDED.accrued),
              updated_at = NOW()
      `;

      if (priorAccrued === null || expected > priorAccrued) updated += 1;
      else skipped += 1;
    }
  }

  log.info('Monthly leave accrual run', { companyId, year, month, updated, skipped }, 'payrollLeaveService');
  return { updated, skipped };
}

/**
 * Roll balances from `fromYear` into `toYear`, applying per-type
 * max_carry_over caps. Negative balances become zero. Skips employee/type
 * combos where `toYear` already shows non-zero `taken` (safety guard).
 */
export async function rolloverLeaveYear(
  companyId: string,
  fromYear: number,
  toYear: number,
): Promise<AccrualResult> {
  if (toYear <= fromYear) throw new Error('toYear must be greater than fromYear');

  const rows = (await sql`
    SELECT
      plb.employee_id,
      plb.leave_type_id,
      plb.balance AS current_balance,
      plt.max_carry_over
    FROM   payroll_leave_balances plb
    JOIN   payroll_leave_types    plt ON plt.id = plb.leave_type_id
    JOIN   payroll_employees      pe  ON pe.id  = plb.employee_id
    WHERE  pe.company_id = ${companyId}::uuid
      AND  plt.company_id = ${companyId}::uuid
      AND  plb.balance_year = ${fromYear}
      AND  plt.is_active = TRUE
  `) as DbRow[];

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const carry = computeCarryOver(
      Number(row.current_balance),
      row.max_carry_over == null ? null : Number(row.max_carry_over),
    );

    const existing = (await sql`
      SELECT taken FROM payroll_leave_balances
      WHERE employee_id  = ${row.employee_id as string}::uuid
        AND leave_type_id = ${row.leave_type_id as string}::uuid
        AND balance_year  = ${toYear}
    `) as DbRow[];
    if (existing.length > 0 && Number(existing[0]?.taken ?? 0) > 0) {
      skipped += 1;
      continue;
    }

    await sql`
      INSERT INTO payroll_leave_balances
        (company_id, employee_id, leave_type_id, balance_year, accrued, taken, pending)
      VALUES
        (${companyId}::uuid, ${row.employee_id as string}::uuid, ${row.leave_type_id as string}::uuid, ${toYear}, ${carry}, 0, 0)
      ON CONFLICT (employee_id, leave_type_id, balance_year) DO UPDATE
        SET accrued = EXCLUDED.accrued,
            updated_at = NOW()
    `;
    updated += 1;
  }

  log.info('Leave year rollover', { companyId, fromYear, toYear, updated, skipped }, 'payrollLeaveService');
  return { updated, skipped };
}
