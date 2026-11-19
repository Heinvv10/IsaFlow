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
 *       - weekly or fortnightly: unsupportedTerms, the terms calculate cannot cost (a fringe benefit,
 *         a 38xx or 3701 component, a percent-of-RFI row, an active loan, a regular-pay directive), in force from today
 *         (400; Hein ruling §0a.11).
 * Each change writes one audit_log `update` row; the value already on file writes nothing.
 */
import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { lockCompanyPayrollForComponentChange } from './payrollCompanyLock';
import { payFrequencyOf } from './payrollFrequency';
import { isPayFrequencyRefused, PayFrequencyRefusedError, unsupportedTerms } from './payrollFrequencyGuard';
import { assertFrequencyChangeAllowed } from './payrollFrequencyChange';
import { employeeName } from './payrollFrequencyStraddle';
import { todaySast } from './payrollPayWeekSettings';
import type { PayFrequency, UnsupportedValue } from './payrollTypesRun';
import type { EmployeeEmailActor } from './payrollEmployeeEmail';

export class EmployeePayFrequencyForbidden extends Error {
  constructor() {
    super("Only an owner or admin can change an employee's pay frequency.");
    this.name = 'EmployeePayFrequencyForbidden';
  }
}

const has = (v: unknown) => Array.isArray(v) && v.length > 0;

/** unsupportedTerms' row in plain words: 'a fringe benefit', 'an active loan', 'a regular-pay tax directive'. */
function termsWords(row: DbRow): string[] {
  return [has(row.fringe) && 'a fringe benefit', has(row.loans) && 'an active loan', has(row.directives) && 'a regular-pay tax directive']
    .filter((x): x is string => typeof x === 'string');
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
      SELECT pay_frequency, first_name, last_name FROM payroll_employees WHERE id = ${employeeId}::uuid AND company_id = ${companyId}::uuid FOR UPDATE
    `) as DbRow[];
    if (rows.length === 0) return null;
    const old = String(rows[0]!.pay_frequency);
    if (old === frequency) return { payFrequency: frequency };
    if (!mayChange) throw new EmployeePayFrequencyForbidden();
    const name = employeeName(rows[0]!);
    try {
      await assertFrequencyChangeAllowed(companyId, employeeId, frequency, today);
    } catch (err) {
      // The mid-year rule, in the writer's words (review #1622 UI M2); its overlap refusal is already the user's sentence.
      if (isPayFrequencyRefused(err) && err.reasons.some((r) => r.clause === 'frequency_change')) {
        throw new PayFrequencyRefusedError(409, [{ clause: 'frequency_change', detail: `${name} was paid at another frequency earlier in `
          + `this tax year. A pay frequency can change only at the start of a tax year, on 1 March.` }], 'PAY_FREQUENCY_REFUSED', true);
      }
      throw err;
    }
    if (frequency !== 'monthly') {
      // The terms calculate cannot cost (FQc's unsupportedTerms, the same check), said for this employee.
      const what = termsWords(await unsupportedTerms(companyId, [employeeId], today, OPEN_END));
      if (what.length > 0) {
        throw new PayFrequencyRefusedError(400, [{ clause: 'frequency_terms', detail: `${name} has ${what.join(' and ')}, which ${frequency} `
          + `pay can't cover yet. End ${what.length > 1 ? 'them' : 'it'} first, or keep ${name} ${old}.` }], 'PAY_FREQUENCY_REFUSED', true);
      }
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
