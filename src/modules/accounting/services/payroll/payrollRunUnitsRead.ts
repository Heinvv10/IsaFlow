/**
 * The reads of the pay-run grid's overtime hours and travel km (wave 6 RI; the writes are payrollRunUnitsInput.ts): which
 * component each is recorded on, this month's rows, and the hourly rate overtime is priced at.
 */
import { sql } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { normaliseSarsCode } from './payeAnnualPayment';
import { hoursComponentOf } from './payrollRunHoursRead';
import { getEmployeeComponents } from './payrollComponentService';
import { overtimeHourlyRate } from './payrollRunInputUnits';
import { monthBounds, type RunPeriod } from './payrollRunPeriodInputsRead';
import { payrollRunReadDate } from './payrollRunReadDate';
import type { PayrollEmployee } from './payrollTypes';

export type UnitKind = 'overtime' | 'travel';
export interface RunUnitRow { employeeId: string; kind: UnitKind; multiplier: number | null; quantity: number; amount: number }
export interface RunInputUnits {
  overtimeComponentId: string | null;
  travelComponentId: string | null;
  /** Hourly rate overtime is priced at, per employee on the run; null: it cannot be told (no rate, or no hours a week). */
  rates: Array<{ employeeId: string; hourlyRate: number | null }>;
  rows: RunUnitRow[];
  /** Employees with two rows for one kind and multiplier: the write refuses them 409, the grid sends them to the employee page. */
  conflicts: Array<{ employeeId: string; kind: UnitKind; multiplier: number | null }>;
  /** Business km recorded from 1 March of the tax year to this month's end, per employee: shown only, never in the tax (no km threshold). */
  kmToDate: Array<{ employeeId: string; km: number }>;
}

/** The one active earning a kind is recorded on: overtime 3607; travel 3703, else 3702. Null when none or several. */
export async function unitComponents(companyId: string): Promise<Record<UnitKind, string | null>> {
  const rows = (await sql`
    SELECT id, sars_source_code FROM payroll_components
     WHERE company_id = ${companyId}::uuid AND is_active = TRUE AND component_type = 'earning'
  `) as DbRow[];
  const only = (code: string) => {
    const ids = rows.filter((r) => normaliseSarsCode(String(r.sars_source_code)) === code).map((r) => String(r.id));
    return ids.length === 1 ? ids[0]! : null;
  };
  return { overtime: only('3607'), travel: only('3703') ?? only('3702') };
}

export const kindOf = (r: DbRow): UnitKind => (r.quantity_unit === 'km' ? 'travel' : 'overtime');

/** This month's overtime and km rows of the company's employees (on the row key or not: one off the key is a conflict). */
export async function unitRows(db: TxSql, companyId: string, period: RunPeriod, employeeIds: string[], lock: boolean): Promise<DbRow[]> {
  const { from, to } = monthBounds(period);
  const rows = (await db`
    SELECT pec.id, pec.employee_id, pec.quantity, pec.quantity_unit, pec.rate_multiplier, pec.amount,
           (pec.effective_from = ${from}::date AND pec.effective_to = ${to}::date AND pec.is_recurring = FALSE) AS on_key
      FROM payroll_employee_components pec
      JOIN payroll_employees e ON e.id = pec.employee_id AND e.company_id = ${companyId}::uuid
     WHERE pec.employee_id = ANY(${employeeIds}::uuid[]) AND pec.superseded_at IS NULL
       AND (pec.rate_multiplier IS NOT NULL OR pec.quantity_unit = 'km')
       AND pec.effective_from <= ${to}::date AND (pec.effective_to IS NULL OR pec.effective_to >= ${from}::date)
     ORDER BY pec.employee_id, pec.quantity_unit, pec.rate_multiplier, pec.id
  `) as DbRow[];
  if (lock && rows.length > 0) {
    await db`SELECT id FROM payroll_employee_components WHERE id = ANY(${rows.map((r) => String(r.id))}::uuid[]) ORDER BY id FOR UPDATE`;
  }
  return rows;
}

/** Km rows of the tax year (from 1 March) to this month's end, summed per employee. Read for display: tax never turns on it. */
async function kmToDateOf(companyId: string, period: RunPeriod, employeeIds: string[]): Promise<RunInputUnits['kmToDate']> {
  const { to } = monthBounds(period);
  const yearStart = `${period.month >= 3 ? period.year : period.year - 1}-03-01`;
  const rows = (await sql`
    SELECT pec.employee_id, SUM(pec.quantity)::float8 AS km
      FROM payroll_employee_components pec
      JOIN payroll_employees e ON e.id = pec.employee_id AND e.company_id = ${companyId}::uuid
     WHERE pec.employee_id = ANY(${employeeIds}::uuid[]) AND pec.superseded_at IS NULL AND pec.quantity_unit = 'km'
       AND pec.effective_from >= ${yearStart}::date AND pec.effective_from <= ${to}::date
     GROUP BY pec.employee_id
  `) as DbRow[];
  return rows.map((r) => ({ employeeId: String(r.employee_id), km: Number(r.km) }));
}

/**
 * The monthly basic overtime is priced on: the recurring amount of the employee's one Basic Salary, picked as the hours are
 * (payrollRunHoursRead.hoursComponentOf: the only 3601, else the one named "Basic Salary"). Other 3601 earnings (allowances,
 * leave pay, corrections) are not the basic (review #1580 M2). 0 when none can be told: the write then refuses overtime.
 */
export async function monthlyBasicOf(companyId: string, employee: PayrollEmployee, period: RunPeriod): Promise<number> {
  const recurring = (await getEmployeeComponents(employee.id, companyId, payrollRunReadDate(period))).filter((c) => c.isRecurring !== false);
  const distinct = [...new Map(recurring.map((c) => [c.component.id, c.component])).values()];
  const found = hoursComponentOf(distinct);
  if (!('component' in found)) return 0;
  return recurring.filter((c) => c.component.id === found.component.id).reduce((t, c) => t + c.amount, 0);
}

export async function readRunInputUnits(companyId: string, period: RunPeriod, employees: PayrollEmployee[]): Promise<RunInputUnits> {
  const components = await unitComponents(companyId);
  const rows = await unitRows(sql, companyId, period, employees.map((e) => e.id), false);
  const rates: RunInputUnits['rates'] = [];
  for (const e of employees) rates.push({ employeeId: e.id, hourlyRate: overtimeHourlyRate(e, await monthlyBasicOf(companyId, e, period)) });
  const key = (r: DbRow) => `${String(r.employee_id)}|${kindOf(r)}|${r.rate_multiplier ?? ''}`;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(key(r), (counts.get(key(r)) ?? 0) + (r.on_key === true ? 1 : 2));
  const mult = (r: DbRow) => (r.rate_multiplier == null ? null : Number(r.rate_multiplier));
  return {
    overtimeComponentId: components.overtime, travelComponentId: components.travel, rates,
    rows: rows.filter((r) => counts.get(key(r)) === 1).map((r) => ({
      employeeId: String(r.employee_id), kind: kindOf(r), multiplier: mult(r), quantity: Number(r.quantity), amount: Number(r.amount),
    })),
    kmToDate: await kmToDateOf(companyId, period, employees.map((e) => e.id)),
    conflicts: [...new Map(rows.filter((r) => counts.get(key(r))! > 1).map((r) => [key(r), { employeeId: String(r.employee_id), kind: kindOf(r), multiplier: mult(r) }])).values()],
  };
}

