/**
 * Tax Directive Service
 * SARS lump sum, retirement, severance & death directives — multi-tenant.
 * All queries scoped by company_id.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { underFlowLockBudget } from '@/modules/accounting/services/core/rowLockBudget';
import { directivePaidBy, TaxDirectivePaidError } from './taxDirectivePaidGuard';
import { isRegularPayDirectiveType } from './taxDirectiveKinds';
import { TaxDirectiveWindowError } from './taxDirectiveOverlap';
import { regularDirectiveLatestUse } from './payrollRunDirectiveUses';
import {
  auditLeaverExit, judgeRegularDirectiveChange, judgeRegularDirectiveCreate, lockForRegularChange, regularDirectiveRow,
} from './taxDirectiveRegularPayChange';
import { auditLeaverExitUndo } from './taxDirectiveLeaverUndo';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { approversAtCreate, auditDirectiveApproval, judgeDirectiveApprover } from './taxDirectiveApprover';
import { mapRow, type DirectiveStatus, type TaxDirective, type TaxDirectiveCreateInput, type ListTaxDirectivesFilter } from './taxDirectiveModel';

export { TaxDirectivePaidError };

export type {
  DirectiveType, DirectiveStatus, TaxDirective, TaxDirectiveCreateInput, ListTaxDirectivesFilter,
} from './taxDirectiveModel';

// ─── Service Functions ────────────────────────────────────────────────────────

export async function listTaxDirectives(
  companyId: string,
  filter: ListTaxDirectivesFilter = {},
): Promise<TaxDirective[]> {
  log.debug('listTaxDirectives', { companyId, ...filter });

  const rows = await sql`
    SELECT *
    FROM tax_directives
    WHERE company_id = ${companyId}
      AND (${filter.status ?? null}::text IS NULL OR status = ${filter.status ?? null})
      AND (
        ${filter.search ?? null}::text IS NULL
        OR employee_name ILIKE ${'%' + (filter.search ?? '') + '%'}
      )
    ORDER BY effective_date DESC, created_at DESC
  `;

  return rows.map(mapRow);
}

export async function getTaxDirective(
  companyId: string,
  id: string,
): Promise<TaxDirective | null> {
  log.debug('getTaxDirective', { companyId, id });

  const rows = await sql`
    SELECT *
    FROM tax_directives
    WHERE company_id = ${companyId}
      AND id = ${id}
    LIMIT 1
  `;

  return rows.length ? mapRow(rows[0]!) : null;
}

export async function createTaxDirective(
  companyId: string,
  input: TaxDirectiveCreateInput,
  requestedByUserId: string,
): Promise<TaxDirective> {
  log.info('createTaxDirective', { companyId, directive_type: input.directive_type });

  // A regular-pay directive (IRP3(b)/(c)): Login-as refused, then judged under the employee's lock before the insert
  // (taxDirectiveRegularPayChange). Its fixed amount, or none for a percentage (taxDirectiveKinds).
  const regular = isRegularPayDirectiveType(input.directive_type);
  if (regular && input.employee_id) await judgeRegularDirectiveCreate(companyId, input.employee_id, input.effective_date, input.expiry_date ?? null);
  const taxAmount = regular
    ? (input.directive_type === 'fixed_amount' ? input.tax_amount ?? null : null)
    : input.tax_rate != null ? Math.round(input.amount * input.tax_rate * 100) / 100 : null;

  const rows = await sql`
    INSERT INTO tax_directives (
      company_id, employee_id, employee_name, employee_tax_number,
      directive_number, directive_type, amount, tax_rate, tax_amount,
      effective_date, issued_date, expiry_date, status, sars_reference, notes, requested_by, approvers_at_create
    ) VALUES (
      ${companyId},
      ${input.employee_id ?? null},
      ${input.employee_name},
      ${input.employee_tax_number ?? null},
      ${input.directive_number ?? null},
      ${input.directive_type},
      ${input.amount},
      ${input.tax_rate ?? null},
      ${taxAmount},
      ${input.effective_date},
      ${input.issued_date ?? null},
      ${input.expiry_date ?? null},
      'pending',
      ${input.sars_reference ?? null},
      ${input.notes ?? null},
      ${requestedByUserId},
      ${await approversAtCreate(companyId, requestedByUserId)}::text[]
    )
    RETURNING *
  `;

  return mapRow(rows[0]!);
}

export interface TaxDirectiveChange {
  status?: DirectiveStatus;
  /** YYYY-MM-DD, or null to clear. */
  issued_date?: string | null;
  /** Regular-pay directives only: YYYY-MM-DD, set or shortened (taxDirectiveRegularPayChange). */
  expiry_date?: string;
}

export async function updateTaxDirectiveStatus(
  companyId: string,
  id: string,
  status: DirectiveStatus,
  approvedByUserId?: string,
): Promise<TaxDirective | null> {
  return updateTaxDirective(companyId, id, { status }, approvedByUserId);
}

/**
 * Change a directive's status and/or issued date. A PAID directive (any
 * tax_directive_payments row: a run's claim or a stand-alone payment) keeps
 * status 'approved': moving it anywhere else is refused with
 * TaxDirectivePaidError, nothing written (Hein 2026-10-22, PAYE 4a follow-ups
 * G5). Expired and pending are refused for the same reason as cancelled: the
 * payment stands on the directive (it is declared on the EMP201 and the
 * certificate), and a reopened run that pays it could not be approved again.
 *
 * LOCK ORDER. This takes the directive row FOR UPDATE (5s bound) and then
 * reads its payment without a lock. payrollRunDirectiveClaim takes the
 * directive rows FOR SHARE (after the company approval lock, run header and
 * journal chain) and then the payment row; applyTaxDirective takes the
 * directive row FOR SHARE and then the payment row. All three take the
 * directive row first and this one takes nothing after it, so no cycle: a
 * cancel waits for a claim or payment in flight and then sees its row, and a
 * claim or payment waits for a cancel and then sees the new status.
 */
export async function updateTaxDirective(
  companyId: string,
  id: string,
  change: TaxDirectiveChange,
  approvedByUserId?: string,
  /** Who made the change (the audit row of an expiry that takes the leaver exit). */
  actorUserId?: string,
): Promise<TaxDirective | null> {
  log.info('updateTaxDirective', { companyId, id, status: change.status, issuedDate: change.issued_date });

  // Approving sets an employee's PAYE: refused under Login-as (all types). A regular-pay directive's change takes the
  // employee's lock first, then this row (taxDirectiveOverlap's order), and is judged before the write.
  if (change.status === 'approved') await assertNotImpersonating();
  const regular = change.status !== undefined || change.expiry_date !== undefined ? await regularDirectiveRow(companyId, id) : null;
  if (change.expiry_date !== undefined && !regular) throw new TaxDirectiveWindowError('Only a fixed-percentage or fixed-amount directive takes an expiry date change');
  if (regular) await lockForRegularChange(companyId, regular);

  const locked = await underFlowLockBudget('This tax directive', async () => (await sql`
    SELECT id, directive_number, status FROM tax_directives
    WHERE company_id = ${companyId} AND id = ${id}
    FOR UPDATE
  `) as DbRow[]);
  if (!locked[0]) return null;

  if (change.status !== undefined && change.status !== 'approved') {
    const paid = await directivePaidBy(companyId, id, locked[0].directive_number);
    if (paid) throw new TaxDirectivePaidError(id, paid);
  }
  // Judged on the row as it is under both locks (status and expiry may have moved since the unlocked read).
  const fresh = regular ? await regularDirectiveRow(companyId, id) : null;
  const judged = fresh ? await judgeRegularDirectiveChange(companyId, fresh, change, actorUserId ?? null) : null;
  // The undo of a leaver exit restores the expiry it had, which may be none (taxDirectiveLeaverUndo).
  const restoreNull = judged?.undo != null && judged.undo.oldExpiry == null;
  // Four eyes (Hein, #1266 round 2): judged before the write; the audit row follows it in the same transaction.
  const approving = change.status === 'approved' && locked[0].status !== 'approved' && approvedByUserId != null;
  const approval = approving ? await judgeDirectiveApprover(companyId, id, approvedByUserId!) : null;

  const setIssued = change.issued_date !== undefined;
  const rows = await sql`
    UPDATE tax_directives
    SET
      status = COALESCE(${change.status ?? null}::text, status),
      issued_date = CASE WHEN ${setIssued}::boolean THEN ${change.issued_date ?? null}::date ELSE issued_date END,
      expiry_date = CASE WHEN ${restoreNull}::boolean THEN NULL ELSE COALESCE(${judged?.undo?.oldExpiry ?? change.expiry_date ?? null}::date, expiry_date) END,
      approved_by = CASE
        WHEN ${approvedByUserId ?? null}::uuid IS NOT NULL THEN ${approvedByUserId ?? null}::uuid
        ELSE approved_by
      END,
      updated_at = NOW()
    WHERE company_id = ${companyId}
      AND id = ${id}
    RETURNING *
  `;

  if (approval && rows.length) await auditDirectiveApproval(companyId, id, approvedByUserId!, approval.selfApproval, mapRow(rows[0]!).expiryDate);
  if (fresh && judged?.undo && rows.length && actorUserId) await auditLeaverExitUndo(companyId, fresh, judged.undo, actorUserId);
  if (fresh && judged?.leaverExitPeriods && rows.length && actorUserId) {
    await auditLeaverExit(companyId, fresh, change.expiry_date!, judged.leaverExitPeriods, actorUserId);
  }
  return rows.length ? mapRow(rows[0]!) : null;
}

/**
 * Delete a directive. Refused with TaxDirectivePaidError (route: 409, nothing
 * written) while its payment stands (the paid guard, as for a cancel), and
 * while any payment row still names it (a run's claim or a stand-alone payment
 * whose journal is undone: the row is the record of what was paid, and the
 * foreign key would turn the delete into a 500). Cancelling stays possible.
 * Same lock as updateTaxDirective: the directive row FOR UPDATE, nothing after.
 */
export async function deleteTaxDirective(
  companyId: string,
  id: string,
): Promise<boolean> {
  log.info('deleteTaxDirective', { companyId, id });
  // A regular-pay directive: Login-as refused and the same locks as a cancel (taxDirectiveRegularPayChange), first.
  const regular = await regularDirectiveRow(companyId, id);
  if (regular) await lockForRegularChange(companyId, regular);

  const locked = await underFlowLockBudget('This tax directive', async () => (await sql`
    SELECT id, directive_number FROM tax_directives
    WHERE company_id = ${companyId} AND id = ${id}
    FOR UPDATE
  `) as DbRow[]);
  if (!locked[0]) return false;
  const which = `SARS directive ${String(locked[0].directive_number ?? id)}`;
  const paid = await directivePaidBy(companyId, id, locked[0].directive_number);
  // Its own message, naming what paid it (the guard's explanation, quoted whole).
  if (paid) throw new TaxDirectivePaidError(id, `${which} cannot be deleted: it is paid. ${paid}`);
  const recorded = (await sql`
    SELECT 1 FROM tax_directive_payments WHERE company_id = ${companyId} AND tax_directive_id = ${id} LIMIT 1
  `) as DbRow[];
  if (recorded.length > 0) {
    throw new TaxDirectivePaidError(id, `${which} has a payment record (a payroll run's `
      + 'claim or a reversed stand-alone payment), so it cannot be deleted. Cancel it instead.');
  }
  // A regular-pay directive an approved or paid run's line was taxed by is that PAYE's record (payrollRunRegularDirective).
  const taxedRun = await regularDirectiveLatestUse(companyId, id);
  if (taxedRun) throw new TaxDirectivePaidError(id, `${which} decided PAYE on the ${taxedRun.period} payroll run, so it cannot be deleted. Set an expiry date instead.`);

  const rows = await sql`
    DELETE FROM tax_directives
    WHERE company_id = ${companyId}
      AND id = ${id}
    RETURNING id
  `;

  return rows.length > 0;
}
