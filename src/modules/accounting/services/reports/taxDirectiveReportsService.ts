/**
 * Tax Directive Service — SARS Lump Sum Tax Directives
 * Manages directives for retirement, severance, death, and lump sum payments.
 * SA tax table brackets per SARS 2024 retirement/severance schedule.
 */

import { sql } from '@/lib/neon';
import {assertIndependentRequestReview} from '@/modules/accounting/services/controls/independentReview';
import { log } from '@/lib/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DirectiveType = 'lump_sum' | 'retirement' | 'severance' | 'death';
export type DirectiveStatus = 'pending' | 'approved' | 'expired' | 'cancelled';

export interface TaxDirective {
  id: string;
  company_id: string;
  employee_id: string | null;
  employee_name: string;
  employee_tax_number: string | null;
  directive_number: string | null;
  directive_type: DirectiveType;
  amount: number;
  tax_rate: number | null;
  tax_amount: number | null;
  effective_date: string | Date;
  expiry_date: string | Date | null;
  status: DirectiveStatus;
  sars_reference: string | null;
  notes: string | null;
  requested_by: string | null;
  approved_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface TaxDirectiveInput {
  employee_id?: string;
  employee_name: string;
  employee_tax_number?: string;
  directive_number?: string;
  directive_type: DirectiveType;
  amount: number;
  tax_rate?: number;
  tax_amount?: number;
  effective_date: string;
  expiry_date?: string;
  sars_reference?: string;
  notes?: string;
}

// Re-export pure calculation types from shared util (no DB deps — safe for UI imports)
export type { LumpSumBracket, LumpSumCalculation } from '@/lib/taxCalculations';
export { calculateLumpSumTax } from '@/lib/taxCalculations';

// ─── DB functions ─────────────────────────────────────────────────────────────

export async function listTaxDirectives(
  companyId: string,
  filters?: { status?: string }
): Promise<TaxDirective[]> {
  try {
    let rows: TaxDirective[];

    if (filters?.status && filters.status !== 'all') {
      rows = await sql`
        SELECT * FROM tax_directives
        WHERE company_id = ${companyId}::UUID
          AND status = ${filters.status}
        ORDER BY created_at DESC
        LIMIT 500
      ` as TaxDirective[];
    } else {
      rows = await sql`
        SELECT * FROM tax_directives
        WHERE company_id = ${companyId}::UUID
        ORDER BY created_at DESC
        LIMIT 500
      ` as TaxDirective[];
    }

    return rows;
  } catch (err) {
    log.error('listTaxDirectives failed', { companyId, error: err }, 'tax-directive-service');
    throw err;
  }
}

export async function createTaxDirective(
  companyId: string,
  input: TaxDirectiveInput,
  userId: string
): Promise<TaxDirective> {
  const {
    employee_id = null,
    employee_name,
    employee_tax_number = null,
    directive_number = null,
    directive_type,
    amount,
    tax_rate = null,
    tax_amount = null,
    effective_date,
    expiry_date = null,
    sars_reference = null,
    notes = null,
  } = input;

  try {
    const rows = await sql`
      INSERT INTO tax_directives (
        company_id, employee_id, employee_name, employee_tax_number,
        directive_number, directive_type, amount, tax_rate, tax_amount,
        effective_date, expiry_date, sars_reference, notes, requested_by
      ) VALUES (
        ${companyId}::UUID,
        ${employee_id}::UUID,
        ${employee_name},
        ${employee_tax_number},
        ${directive_number},
        ${directive_type},
        ${amount},
        ${tax_rate},
        ${tax_amount},
        ${effective_date}::DATE,
        ${expiry_date ?? null},
        ${sars_reference},
        ${notes},
        ${userId}::UUID
      )
      RETURNING *
    ` as TaxDirective[];

    log.info('Tax directive created', { companyId, id: rows[0]?.id }, 'tax-directive-service');
    return rows[0]!;
  } catch (err) {
    log.error('createTaxDirective failed', { companyId, error: err }, 'tax-directive-service');
    throw err;
  }
}

export async function updateTaxDirectiveStatus(
  companyId: string,
  id: string,
  status: string,
  userId: string
): Promise<TaxDirective> {
  if (status === 'approved') assertIndependentRequestReview();
  const validStatuses: DirectiveStatus[] = ['pending', 'approved', 'expired', 'cancelled'];
  if (!validStatuses.includes(status as DirectiveStatus)) {
    throw new Error(`Invalid status: ${status}`);
  }

  try {
    const approvedBy = status === 'approved' ? userId : null;

    const rows = await sql`
      UPDATE tax_directives
      SET
        status = ${status},
        approved_by = CASE WHEN ${status} = 'approved' THEN ${approvedBy}::UUID ELSE approved_by END,
        updated_at = NOW()
      WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
      RETURNING *
    ` as TaxDirective[];

    if (rows.length === 0) {
      throw new Error('Tax directive not found or access denied');
    }

    log.info('Tax directive status updated', { companyId, id, status }, 'tax-directive-service');
    return rows[0]!;
  } catch (err) {
    log.error('updateTaxDirectiveStatus failed', { companyId, id, error: err }, 'tax-directive-service');
    throw err;
  }
}
