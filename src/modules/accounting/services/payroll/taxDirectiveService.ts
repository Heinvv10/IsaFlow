/**
 * Tax Directive Service
 * SARS lump sum, retirement, severance & death directives — multi-tenant.
 * All queries scoped by company_id.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { underFlowLockBudget } from '@/modules/accounting/services/core/rowLockBudget';
import { directivePaidBy, TaxDirectivePaidError } from './taxDirectivePaidGuard';

export { TaxDirectivePaidError };

// ─── Types ────────────────────────────────────────────────────────────────────

export type DirectiveType = 'lump_sum' | 'retirement' | 'severance' | 'death';
export type DirectiveStatus = 'pending' | 'approved' | 'expired' | 'cancelled';

export interface TaxDirective {
  id: string;
  companyId: string;
  employeeId: string | null;
  employeeName: string;
  employeeTaxNumber: string | null;
  directiveNumber: string | null;
  directiveType: DirectiveType;
  amount: number;
  taxRate: number | null;
  taxAmount: number | null;
  effectiveDate: string;
  /** The date SARS issued the directive (e@syFile 3231); null when not captured. */
  issuedDate: string | null;
  expiryDate: string | null;
  status: DirectiveStatus;
  sarsReference: string | null;
  notes: string | null;
  requestedBy: string | null;
  approvedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaxDirectiveCreateInput {
  employee_id?: string;
  employee_name: string;
  employee_tax_number?: string;
  directive_number?: string;
  directive_type: DirectiveType;
  amount: number;
  tax_rate?: number;
  effective_date: string;
  issued_date?: string;
  expiry_date?: string;
  sars_reference?: string;
  notes?: string;
}

export interface ListTaxDirectivesFilter {
  status?: DirectiveStatus;
  search?: string;
}

// ─── Mapper ───────────────────────────────────────────────────────────────────

function mapRow(row: DbRow): TaxDirective {
  const toDate = (v: unknown): string => fmtDate(v);

  return {
    id: String(row.id),
    companyId: String(row.company_id),
    employeeId: row.employee_id != null ? String(row.employee_id) : null,
    employeeName: String(row.employee_name),
    employeeTaxNumber: row.employee_tax_number != null ? String(row.employee_tax_number) : null,
    directiveNumber: row.directive_number != null ? String(row.directive_number) : null,
    directiveType: String(row.directive_type) as DirectiveType,
    amount: parseFloat(String(row.amount)),
    taxRate: row.tax_rate != null ? parseFloat(String(row.tax_rate)) : null,
    taxAmount: row.tax_amount != null ? parseFloat(String(row.tax_amount)) : null,
    effectiveDate: toDate(row.effective_date),
    issuedDate: row.issued_date != null ? toDate(row.issued_date) : null,
    expiryDate: row.expiry_date != null ? toDate(row.expiry_date) : null,
    status: String(row.status) as DirectiveStatus,
    sarsReference: row.sars_reference != null ? String(row.sars_reference) : null,
    notes: row.notes != null ? String(row.notes) : null,
    requestedBy: row.requested_by != null ? String(row.requested_by) : null,
    approvedBy: row.approved_by != null ? String(row.approved_by) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

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

  const taxAmount =
    input.tax_rate != null ? Math.round(input.amount * input.tax_rate * 100) / 100 : null;

  const rows = await sql`
    INSERT INTO tax_directives (
      company_id, employee_id, employee_name, employee_tax_number,
      directive_number, directive_type, amount, tax_rate, tax_amount,
      effective_date, issued_date, expiry_date, status, sars_reference, notes, requested_by
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
      ${requestedByUserId}
    )
    RETURNING *
  `;

  return mapRow(rows[0]!);
}

export interface TaxDirectiveChange {
  status?: DirectiveStatus;
  /** YYYY-MM-DD, or null to clear. */
  issued_date?: string | null;
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
): Promise<TaxDirective | null> {
  log.info('updateTaxDirective', { companyId, id, status: change.status, issuedDate: change.issued_date });

  const locked = await underFlowLockBudget('This tax directive', async () => (await sql`
    SELECT id, directive_number FROM tax_directives
    WHERE company_id = ${companyId} AND id = ${id}
    FOR UPDATE
  `) as DbRow[]);
  if (!locked[0]) return null;

  if (change.status !== undefined && change.status !== 'approved') {
    const paid = await directivePaidBy(companyId, id, locked[0].directive_number);
    if (paid) throw new TaxDirectivePaidError(id, paid);
  }

  const setIssued = change.issued_date !== undefined;
  const rows = await sql`
    UPDATE tax_directives
    SET
      status = COALESCE(${change.status ?? null}::text, status),
      issued_date = CASE WHEN ${setIssued}::boolean THEN ${change.issued_date ?? null}::date ELSE issued_date END,
      approved_by = CASE
        WHEN ${approvedByUserId ?? null}::uuid IS NOT NULL THEN ${approvedByUserId ?? null}::uuid
        ELSE approved_by
      END,
      updated_at = NOW()
    WHERE company_id = ${companyId}
      AND id = ${id}
    RETURNING *
  `;

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

  const rows = await sql`
    DELETE FROM tax_directives
    WHERE company_id = ${companyId}
      AND id = ${id}
    RETURNING id
  `;

  return rows.length > 0;
}
