/**
 * Tax Directive Service — SARS Lump Sum Tax Directives
 * Manages directives for retirement, severance, death, and lump sum payments.
 * SA tax table brackets: SARS retirement/severance lump-sum table, tax year LUMP_SUM_TAX_YEAR (src/lib/taxCalculations.ts).
 */

import { sql } from '@/lib/neon';
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
