/**
 * What may happen to a regular-pay directive (IRP3(b) / IRP3(c); wave 5 DR) on create, approve, cancel and an expiry
 * change, all judged BEFORE the request writes anything (a 4xx commits what was written: none is).
 *
 * - Create / approve: under the employee's advisory lock (taxDirectiveOverlap), no overlap with the employee's other
 *   regular-pay directives (pending or approved at create, approved at approve), and no window over a period already
 *   approved or paid for that employee: that run's PAYE stands (a reopened run would be retaxed), so a retroactive
 *   directive is REFUSED with a 400 naming the period; the employer applies it from the first period not yet approved.
 * - Leaving 'approved' (cancel, pending, expired) once an approved or paid run was taxed by it: 409, "set an expiry date
 *   instead" (TaxDirectivePaidError, as the lump-sum paid guard), so reopening that run cannot quietly retax it.
 * - Expiry: set or SHORTEN only (never later than the window it has, the tax year's end when none), never before the
 *   judge date of an approved or paid run it taxed, never before its effective date; under the employee's lock.
 *   A shortened window makes the next run DIRECTIVE_ENDED.
 * Every path is refused under Login-as (assertNotImpersonating): each sets an employee's PAYE.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { TaxDirectivePaidError } from './taxDirectivePaidGuard';
import {
  assertNoRegularDirectiveOverlap, directiveEndsOn, lockEmployeeRegularDirectives, TaxDirectiveWindowError,
} from './taxDirectiveOverlap';
import { declarableRunInWindow, regularDirectiveLatestUse } from './payrollRunRegularDirective';
import { REGULAR_PAY_DIRECTIVE_TYPES } from './taxDirectiveKinds';

export interface RegularDirectiveRow { id: string; employeeId: string; effectiveDate: string; expiryDate: string | null; status: string; number: string | null }

/** The directive's row when it is a regular-pay one of this company (unlocked: type, employee and effective date never change). */
export async function regularDirectiveRow(companyId: string, id: string): Promise<RegularDirectiveRow | null> {
  const r = ((await sql`
    SELECT id, employee_id, effective_date::text AS effective_date, expiry_date::text AS expiry_date, status, directive_number
    FROM tax_directives
    WHERE company_id = ${companyId}::uuid AND id = ${id}::uuid AND directive_type = ANY(${[...REGULAR_PAY_DIRECTIVE_TYPES]}::text[])
  `) as DbRow[])[0];
  if (!r || r.employee_id == null) return null;
  return {
    id: String(r.id), employeeId: String(r.employee_id), effectiveDate: String(r.effective_date),
    expiryDate: r.expiry_date == null ? null : String(r.expiry_date), status: String(r.status),
    number: r.directive_number == null ? null : String(r.directive_number),
  };
}

/** Refuse a window over a period already approved or paid for the employee (see the header). */
async function assertNoApprovedRunInWindow(companyId: string, employeeId: string, from: string, to: string): Promise<void> {
  const period = await declarableRunInWindow(companyId, employeeId, from, to);
  if (period) {
    throw new TaxDirectiveWindowError(
      `The ${period} payroll run for this employee is already approved, and it falls inside this directive's window (${from} to ${to}). `
      + 'Its PAYE stands: set the effective date to the first period not yet approved.',
    );
  }
}

/** Create: Login-as refused, the employee's lock, then overlap and approved-run checks. */
export async function judgeRegularDirectiveCreate(companyId: string, employeeId: string, effectiveDate: string, expiryDate: string | null): Promise<void> {
  await assertNotImpersonating();
  await lockEmployeeRegularDirectives(companyId, employeeId);
  const endsOn = directiveEndsOn(effectiveDate, expiryDate);
  await assertNoRegularDirectiveOverlap(companyId, employeeId, { effectiveDate, endsOn, statuses: ['pending', 'approved'] });
  await assertNoApprovedRunInWindow(companyId, employeeId, effectiveDate, endsOn);
}

/** Before the directive's row lock: Login-as and the employee's lock, for any change that judges the window. */
export async function lockForRegularChange(companyId: string, row: RegularDirectiveRow): Promise<void> {
  await assertNotImpersonating();
  await lockEmployeeRegularDirectives(companyId, row.employeeId);
}

/** Under the employee's lock and the row's: refuse the change before the write (see the header). */
export async function judgeRegularDirectiveChange(
  companyId: string, row: RegularDirectiveRow, change: { status?: string; expiry_date?: string },
): Promise<void> {
  const used = await regularDirectiveLatestUse(companyId, row.id);
  const label = `SARS directive ${row.number?.trim() || row.id}`;
  if (change.status !== undefined && change.status !== 'approved' && row.status === 'approved' && used) {
    throw new TaxDirectivePaidError(row.id, `${label} taxed the ${used.period} payroll run, so it stays approved: set an expiry date instead `
      + `(on or after ${used.judgeDate}) to stop it applying to later periods.`);
  }
  const expiry = change.expiry_date ?? row.expiryDate;
  const endsOn = directiveEndsOn(row.effectiveDate, expiry);
  if (change.expiry_date !== undefined) {
    const current = directiveEndsOn(row.effectiveDate, row.expiryDate);
    if (change.expiry_date < row.effectiveDate) throw new TaxDirectiveWindowError(`expiry_date must be on or after the effective date ${row.effectiveDate}`);
    if (change.expiry_date > current) {
      throw new TaxDirectiveWindowError(`An expiry date can only shorten the directive: it runs to ${current} now. SARS issues a new directive for a longer period.`);
    }
    if (used && change.expiry_date < used.judgeDate) {
      throw new TaxDirectiveWindowError(`${label} taxed the ${used.period} payroll run (paid ${used.judgeDate}): the expiry date cannot be before that.`);
    }
  }
  if ((change.status ?? row.status) === 'approved') {
    await assertNoRegularDirectiveOverlap(companyId, row.employeeId, { effectiveDate: row.effectiveDate, endsOn, excludeId: row.id, statuses: ['approved'] });
    // Approving now: no period already approved may fall in its window (one it already taxed is its own, not a retroactive one).
    if (change.status === 'approved' && row.status !== 'approved') await assertNoApprovedRunInWindow(companyId, row.employeeId, row.effectiveDate, endsOn);
  }
}
