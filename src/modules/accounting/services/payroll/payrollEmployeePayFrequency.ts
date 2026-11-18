/**
 * An employee's pay frequency (wave 6 FQd; grill F16: its own field, route and mapper; migration 999a's
 * payroll_employees.pay_frequency). A run pays only the employees of its own frequency (FQa F3), so this decides
 * which runs pay the employee.
 *
 * `setEmployeePayFrequency` writes this company's employee only, under the company's payroll-approval lock (no run is
 * approved between the checks and the write) and the employee's row lock, and refuses BEFORE any write:
 *   - anyone but an owner or admin: it moves pay (EmployeePayFrequencyForbidden, 403);
 *   - what calculate would refuse for the new frequency (coordinator ruling on #1622: frequency change rules shared
 *     with calculate, FQc's payrollFrequencyGuard, one source of truth), as PayFrequencyRefusedError:
 *       - assertFrequencyChangeAllowed: a final line this tax year at another frequency (409, change at the start of a
 *         tax year), or a non-cancelled run of another frequency that already pays the employee this month (409
 *         PAY_PERIOD_OVERLAP);
 *       - weekly or fortnightly: unsupportedTerms / termsReasons, the terms calculate cannot cost (a fringe benefit,
 *         a 38xx or 3701 component, a percent-of-RFI row, an active loan, a regular-pay directive), in force from today
 *         (400; Hein ruling §0a.11).
 * Each change writes one audit_log `update` row; the value already on file writes nothing.
 */
import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { lockCompanyPayrollForComponentChange } from './payrollCompanyLock';
import { payFrequencyOf } from './payrollFrequency';
import { assertFrequencyChangeAllowed, PayFrequencyRefusedError, termsReasons, unsupportedTerms } from './payrollFrequencyGuard';
import { todaySast } from './payrollPayWeekSettings';
import type { PayFrequency, UnsupportedValue } from './payrollTypesRun';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';

export class EmployeePayFrequencyForbidden extends Error {
  constructor() {
    super("Only an owner or admin can change an employee's pay frequency.");
    this.name = 'EmployeePayFrequencyForbidden';
  }
}

/** The last day the terms check looks to: terms in force on or after today, whenever they end. */
const OPEN_END = '9999-12-31';

/** This company's employee's frequency; undefined when the employee is not this company's. */
export async function readEmployeePayFrequency(companyId: string, employeeId: string): Promise<PayFrequency | UnsupportedValue | undefined> {
  const rows = (await sql`
    SELECT pay_frequency FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid
  `) as DbRow[];
  return rows.length === 0 ? undefined : payFrequencyOf(rows[0]!.pay_frequency);
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
    await assertFrequencyChangeAllowed(companyId, employeeId, frequency, today);
    if (frequency !== 'monthly') {
      const reasons = termsReasons(await unsupportedTerms(companyId, [employeeId], today, OPEN_END), frequency);
      if (reasons.length > 0) throw new PayFrequencyRefusedError(400, reasons);
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
