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
 * - Never for an independent contractor (Hein, #1266 round 2): create and approve are 400, "change the tax status first".
 * - "Taxed" and "approved" mean EVER approved: a run approved once and reopened since still counts (payrollRunRegularDirective).
 * Every path (create, approve, cancel, expiry, delete) is refused under Login-as (assertNotImpersonating): each sets an
 * employee's PAYE. Lock order: the company's payroll-approval lock (payrollApprovalLockScope, as approve / calculate /
 * reopen take it first), then the employee's advisory lock, then the directive row: a run approval cannot commit
 * between the judgement and the write.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { TaxDirectivePaidError } from './taxDirectivePaidGuard';
import {
  assertNoRegularDirectiveOverlap, directiveEndsOn, lockEmployeeRegularDirectives, TaxDirectiveWindowError,
} from './taxDirectiveOverlap';
import { declarableRunInWindow } from './payrollRunRegularDirective';
import { regularDirectiveLatestUse, regularDirectiveUsesAfter } from './payrollRunDirectiveUses';
import { REGULAR_PAY_DIRECTIVE_TYPES } from './taxDirectiveKinds';
import { payrollApprovalLockScope } from './payrollRunLock';
import { underFlowLockBudget } from '@/modules/accounting/services/core/rowLockBudget';
import { logAuditOrThrow } from '@/modules/accounting/services/core/auditTrailService';
import { judgeLeaverExitUndo, type LeaverExitUndo } from './taxDirectiveLeaverUndo';
import { approversAtCreate } from './taxDirectiveApprover';

export interface RegularDirectiveRow {
  id: string; employeeId: string; effectiveDate: string; expiryDate: string | null; status: string; number: string | null;
  /** The employee's end date (YYYY-MM-DD), else null. */
  employeeEndDate: string | null;
}

/** The directive's row when it is a regular-pay one of this company (unlocked: type, employee and effective date never change). */
export async function regularDirectiveRow(companyId: string, id: string): Promise<RegularDirectiveRow | null> {
  const r = ((await sql`
    SELECT d.id, d.employee_id, d.effective_date::text AS effective_date, d.expiry_date::text AS expiry_date, d.status, d.directive_number,
           e.end_date::text AS employee_end_date
    FROM tax_directives d
    LEFT JOIN payroll_employees e ON e.id = d.employee_id AND e.company_id = d.company_id
    WHERE d.company_id = ${companyId}::uuid AND d.id = ${id}::uuid AND d.directive_type = ANY(${[...REGULAR_PAY_DIRECTIVE_TYPES]}::text[])
  `) as DbRow[])[0];
  if (!r || r.employee_id == null) return null;
  return {
    id: String(r.id), employeeId: String(r.employee_id), effectiveDate: String(r.effective_date),
    expiryDate: r.expiry_date == null ? null : String(r.expiry_date), status: String(r.status),
    number: r.directive_number == null ? null : String(r.directive_number),
    employeeEndDate: r.employee_end_date == null ? null : String(r.employee_end_date),
  };
}

/** Refuse a window over a period already approved or paid for the employee (see the header). */
async function assertNoApprovedRunInWindow(companyId: string, employeeId: string, from: string, to: string): Promise<void> {
  const period = await declarableRunInWindow(companyId, employeeId, from, to);
  if (period) {
    throw new TaxDirectiveWindowError(
      `The ${period} payroll run for this employee has been approved (reopening it does not undo that), and it falls inside this directive's window (${from} to ${to}). `
      + 'Its PAYE stands: set the effective date to the first period not yet approved.',
    );
  }
}

/** Login-as refused, then the company approval lock and the employee's (see the header). */
async function lockFor(companyId: string, employeeId: string): Promise<void> {
  await assertNotImpersonating();
  await underFlowLockBudget('Payroll for this company', async () => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${payrollApprovalLockScope(companyId)}, 0))`;
  });
  await lockEmployeeRegularDirectives(companyId, employeeId);
}

/** Refuse a regular-pay directive for an independent contractor (Hein, #1266 round 2). */
async function assertNotContractor(companyId: string, employeeId: string): Promise<void> {
  const r = ((await sql`
    SELECT tax_status FROM payroll_employees WHERE company_id = ${companyId}::uuid AND id = ${employeeId}::uuid
  `) as DbRow[])[0];
  if (r?.tax_status === 'independent_contractor') {
    throw new TaxDirectiveWindowError('This employee\'s tax status is independent contractor: a fixed-percentage or fixed-amount directive is for '
      + 'remuneration, so change the tax status first (employee profile, Work terms).');
  }
}

/** Create: Login-as refused, the locks, then contractor, overlap and approved-run checks. */
export async function judgeRegularDirectiveCreate(companyId: string, employeeId: string, effectiveDate: string, expiryDate: string | null): Promise<void> {
  await lockFor(companyId, employeeId);
  await assertNotContractor(companyId, employeeId);
  const endsOn = directiveEndsOn(effectiveDate, expiryDate);
  await assertNoRegularDirectiveOverlap(companyId, employeeId, { effectiveDate, endsOn, statuses: ['pending', 'approved'] });
  await assertNoApprovedRunInWindow(companyId, employeeId, effectiveDate, endsOn);
}

/** Before the directive's row lock, for any change (approve, cancel, expiry, delete): Login-as and the locks. */
export async function lockForRegularChange(companyId: string, row: RegularDirectiveRow): Promise<void> {
  await lockFor(companyId, row.employeeId);
}

/** Under the employee's lock and the row's: refuse the change before the write (see the header). Says when the leaver exit was taken. */
export async function judgeRegularDirectiveChange(
  companyId: string, row: RegularDirectiveRow, change: { status?: string; expiry_date?: string }, actorId: string | null = null,
): Promise<{ leaverExitPeriods: string[] | null; undo: LeaverExitUndo | null }> {
  let leaverExitPeriods: string[] | null = null;
  let undo: LeaverExitUndo | null = null;
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
    // Lengthening is only the narrow undo of a leaver exit (Hein, #1266 L2): taxDirectiveLeaverUndo judges it or refuses.
    if (change.expiry_date > current) undo = await judgeLeaverExitUndo(companyId, row, change.expiry_date, actorId ?? '');
    // Before a run it taxed only to end it at the leave date of an employee who left BEFORE every such run's period (a
    // legitimate leaver, round 4 L2; end date read under the company payroll lock and the employee lock, as the employee
    // update takes the same company lock): the recalculation guard then lets those runs drop the leaver.
    if (used && change.expiry_date < used.judgeDate) {
      const end = row.employeeEndDate;
      const later = await regularDirectiveUsesAfter(companyId, row.id, change.expiry_date);
      const leaver = end != null && change.expiry_date >= end && later.every(u => end < u.firstDay);
      if (!leaver) {
        throw new TaxDirectiveWindowError(`${label} taxed the ${used.period} payroll run (paid ${used.judgeDate}): the expiry date cannot be before that, `
          + 'unless the employee left before that period: then it may end on or after their leave date.');
      }
      leaverExitPeriods = later.map(u => u.period);
    }
  }
  if ((change.status ?? row.status) === 'approved') {
    await assertNoRegularDirectiveOverlap(companyId, row.employeeId, { effectiveDate: row.effectiveDate, endsOn, excludeId: row.id, statuses: ['approved'] });
    // Approving now: no period already approved may fall in its window (one it already taxed is its own, not a retroactive one).
    if (change.status === 'approved' && row.status !== 'approved') {
      await assertNotContractor(companyId, row.employeeId);
      await assertNoApprovedRunInWindow(companyId, row.employeeId, row.effectiveDate, endsOn);
    }
  }
  return { leaverExitPeriods, undo };
}

/**
 * The audit row for an expiry set before a run the directive taxed (the leaver exit, #1266 adv2 L1): it lets those
 * declared runs drop the employee on recalculation, so it is reviewable outside the employee change log. Written on the
 * request's transaction, after the update, so it commits or rolls back with it.
 */
export async function auditLeaverExit(
  companyId: string, row: RegularDirectiveRow, newExpiry: string, periods: string[], userId: string,
): Promise<void> {
  await logAuditOrThrow({
    companyId, userId, action: 'update', entityType: 'tax_directive', entityId: row.id, entityRef: row.number ?? undefined,
    changes: {
      fields: [{ field: 'expiry_date', old: row.expiryDate, new: newExpiry, label: 'Expiry date' }],
      metadata: {
        leaverExit: 'true', employeeId: row.employeeId, employeeEndDate: String(row.employeeEndDate),
        directiveNumber: row.number ?? '', runs: periods.join(','),
        oldEndsOn: directiveEndsOn(row.effectiveDate, row.expiryDate), newExpiry,
        // Who could approve its undo at the time (#1266 adv2 L): the undo's four eyes judge this roster, not today's.
        approversAtExit: (await approversAtCreate(companyId, userId)).join(','),
      },
    },
  });
}
