/**
 * Tax directive types and the row mapper (moved out of taxDirectiveService.ts, unchanged: 300-line cap).
 */

import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import type { DirectiveKind } from './taxDirectiveKinds';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Lump sums (IRP3(a) and the fund forms) and, from wave 5 DR, the regular-pay IRP3(b)/(c) (taxDirectiveKinds). */
export type DirectiveType = DirectiveKind;
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
  /** fixed_amount only: the PAYE a period it directs (stored in tax_amount). */
  tax_amount?: number;
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

export function mapRow(row: DbRow): TaxDirective {
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
