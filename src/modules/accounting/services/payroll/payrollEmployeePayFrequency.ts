/**
 * An employee's pay frequency (wave 6 FQd; grill F16: its own field, route and mapper; migration 999a's
 * payroll_employees.pay_frequency). A run pays only the employees of its own frequency (FQa F3), so this decides
 * which runs pay the employee.
 *
 * `setEmployeePayFrequency` writes this company's employee only, under the company's payroll-approval lock (no run is
 * approved between the checks and the write) and the employee's row lock, and refuses BEFORE any write:
 *   - anyone but an owner or admin: it moves pay (EmployeePayFrequencyForbidden, 403);
 *   - a change once the employee has a line on a FINAL run paid this tax year (FrequencyChangeMidYearError, 409):
 *     the year to date is counted in periods of one frequency (spec FQc: "change frequency at the start of a tax
 *     year"; planner decision 5);
 *   - weekly or fortnightly for an employee with a fringe benefit, an active loan or a regular-pay directive
 *     (FrequencyRefused, 400, naming each): not supported for those frequencies this wave (Hein ruling §0a.11).
 * Each change writes one audit_log `update` row; the value already on file writes nothing.
 */
import { sql, withTransaction } from '@/lib/neon';
import type { DbRow, TxSql } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { lockCompanyPayrollForComponentChange } from './payrollCompanyLock';
import { payRunFinalSql } from './payRunFinalSql';
import { payFrequencyOf } from './payrollFrequency';
import { taxYearStartOf, todaySast } from './payrollPayWeekSettings';
import { REGULAR_PAY_DIRECTIVE_TYPES } from './taxDirectiveKinds';
import type { PayFrequency, UnsupportedValue } from './payrollTypesRun';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';

export class EmployeePayFrequencyForbidden extends Error {
  constructor() {
    super("Only an owner or admin can change an employee's pay frequency.");
    this.name = 'EmployeePayFrequencyForbidden';
  }
}

export class FrequencyChangeMidYearError extends Error {
  readonly code = 'FREQUENCY_CHANGE_MID_YEAR';
  constructor() {
    super('This employee has an approved run this tax year, so the pay frequency can change only at the start of a tax year (1 March).');
    this.name = 'FrequencyChangeMidYearError';
  }
}

export class FrequencyRefused extends Error {
  readonly code = 'FREQUENCY_UNSUPPORTED_FOR_EMPLOYEE';
  constructor(frequency: string, what: string[]) {
    super(`A ${frequency} employee cannot have ${what.join(', ')} yet: end ${what.length > 1 ? 'them' : 'it'} first, or keep the employee monthly.`);
    this.name = 'FrequencyRefused';
  }
}

/** This company's employee's frequency; undefined when the employee is not this company's. */
export async function readEmployeePayFrequency(companyId: string, employeeId: string): Promise<PayFrequency | UnsupportedValue | undefined> {
  const rows = (await sql`
    SELECT pay_frequency FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[];
  return rows.length === 0 ? undefined : payFrequencyOf(rows[0]!.pay_frequency);
}

/** What a weekly or fortnightly employee may not have this wave, in force on or after `today`. */
async function unsupportedFor(db: TxSql, companyId: string, employeeId: string, today: string): Promise<string[]> {
  const rows = (await db`
    SELECT
      EXISTS (SELECT 1 FROM payroll_employee_fringe_benefits f
               WHERE f.company_id = ${companyId}::uuid AND f.employee_id = ${employeeId}::uuid
                 AND (f.effective_to IS NULL OR f.effective_to >= ${today}::date)) AS fringe,
      EXISTS (SELECT 1 FROM payroll_loans l
               WHERE l.company_id = ${companyId}::uuid AND l.employee_id = ${employeeId}::uuid AND l.status = 'active') AS loan,
      EXISTS (SELECT 1 FROM tax_directives d
               WHERE d.company_id = ${companyId}::uuid AND d.employee_id = ${employeeId}::uuid
                 AND d.directive_type = ANY(${[...REGULAR_PAY_DIRECTIVE_TYPES]}::text[])
                 AND d.status IN ('pending', 'approved')
                 AND (d.expiry_date IS NULL OR d.expiry_date >= ${today}::date)) AS directive
  `) as DbRow[];
  const r = rows[0] ?? {};
  return [r.fringe && 'a fringe benefit', r.loan && 'an active loan', r.directive && 'a regular-pay tax directive']
    .filter((x): x is string => typeof x === 'string');
}

export async function setEmployeePayFrequency(
  companyId: string, employeeId: string, frequency: PayFrequency, actor: EmployeeEmailActor, mayChange: boolean,
  today = todaySast(),
): Promise<{ payFrequency: PayFrequency | UnsupportedValue } | null> {
  return withTransaction(async (tx) => {
    await lockCompanyPayrollForComponentChange(tx, companyId);
    const rows = (await tx`
      SELECT pay_frequency FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid FOR UPDATE
    `) as DbRow[];
    if (rows.length === 0) return null;
    const old = String(rows[0]!.pay_frequency);
    if (old === frequency) return { payFrequency: frequency };
    if (!mayChange) throw new EmployeePayFrequencyForbidden();
    const paid = (await tx`
      SELECT 1 FROM payroll_run_lines l JOIN payroll_run_headers h ON h.id = l.run_id
       WHERE l.employee_id = ${employeeId}::uuid AND h.company_id = ${companyId}::uuid
         AND ${sql.unsafe(payRunFinalSql('h'))}
         AND COALESCE(h.run_date::date, h.period_end) >= ${taxYearStartOf(today)}::date
       LIMIT 1
    `) as DbRow[];
    if (paid.length > 0) throw new FrequencyChangeMidYearError();
    if (frequency !== 'monthly') {
      const what = await unsupportedFor(tx, companyId, employeeId, today);
      if (what.length > 0) throw new FrequencyRefused(frequency, what);
    }
    await tx`
      UPDATE payroll_employees SET pay_frequency = ${frequency}, updated_at = now()
       WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
    `;
    await logAuditOrThrow({
      companyId, userId: actor.userId, userEmail: actor.userEmail, action: 'update', entityType: 'payroll_employee',
      entityId: employeeId, changes: { fields: [{ field: 'pay_frequency', old, new: frequency, label: 'Pay frequency' }] },
      ip: actor.ip, userAgent: actor.userAgent, sessionId: actor.sessionId ?? undefined,
    });
    return { payFrequency: frequency };
  });
}
