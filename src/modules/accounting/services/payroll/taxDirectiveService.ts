/**
 * Tax Directive Service
 * SARS lump sum, retirement, severance & death directives — multi-tenant.
 * All queries scoped by company_id.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

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
      effective_date, expiry_date, status, sars_reference, notes, requested_by
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

export async function updateTaxDirectiveStatus(
  companyId: string,
  id: string,
  status: DirectiveStatus,
  approvedByUserId?: string,
): Promise<TaxDirective | null> {
  log.info('updateTaxDirectiveStatus', { companyId, id, status });

  const rows = await sql`
    UPDATE tax_directives
    SET
      status = ${status},
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

export async function deleteTaxDirective(
  companyId: string,
  id: string,
): Promise<boolean> {
  log.info('deleteTaxDirective', { companyId, id });

  const rows = await sql`
    DELETE FROM tax_directives
    WHERE company_id = ${companyId}
      AND id = ${id}
    RETURNING id
  `;

  return rows.length > 0;
}
