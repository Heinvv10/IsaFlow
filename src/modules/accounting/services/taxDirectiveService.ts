/**
 * Tax Directive Service — SARS Lump Sum Tax Directives
 * Manages directives for retirement, severance, death, and lump sum payments.
 * SA tax table brackets per SARS 2024 retirement/severance schedule.
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

export interface LumpSumBracket {
  from: number;
  to: number | null;
  rate: number;
  label: string;
}

export interface LumpSumCalculation {
  grossAmount: number;
  taxableAmount: number;
  taxAmount: number;
  effectiveRate: number;
  directiveRateUsed: boolean;
  breakdown: Array<{ bracket: string; amount: number; tax: number; rate: number }>;
}

// ─── SA SARS Lump Sum Tax Brackets (retirement/severance 2024) ───────────────

const LUMP_SUM_BRACKETS: LumpSumBracket[] = [
  { from: 0,         to: 500_000,   rate: 0.00, label: 'R0 – R500,000 (0%)' },
  { from: 500_000,   to: 700_000,   rate: 0.18, label: 'R500,001 – R700,000 (18%)' },
  { from: 700_000,   to: 1_050_000, rate: 0.27, label: 'R700,001 – R1,050,000 (27%)' },
  { from: 1_050_000, to: null,      rate: 0.36, label: 'Over R1,050,000 (36%)' },
];

// ─── Pure calculation (no DB) ─────────────────────────────────────────────────

export function calculateLumpSumTax(
  grossAmount: number,
  directiveRate: number | null
): LumpSumCalculation {
  if (directiveRate !== null && directiveRate >= 0) {
    const taxAmount = grossAmount * directiveRate;
    return {
      grossAmount,
      taxableAmount: grossAmount,
      taxAmount: Math.round(taxAmount * 100) / 100,
      effectiveRate: directiveRate,
      directiveRateUsed: true,
      breakdown: [
        {
          bracket: `Directive rate (${(directiveRate * 100).toFixed(2)}%)`,
          amount: grossAmount,
          tax: Math.round(taxAmount * 100) / 100,
          rate: directiveRate,
        },
      ],
    };
  }

  // Use SARS table brackets
  let remaining = grossAmount;
  let totalTax = 0;
  const breakdown: LumpSumCalculation['breakdown'] = [];

  for (const bracket of LUMP_SUM_BRACKETS) {
    if (remaining <= 0) break;
    const bracketSize = bracket.to !== null ? bracket.to - bracket.from : Infinity;
    const taxable = Math.min(remaining, bracketSize);
    const tax = taxable * bracket.rate;
    breakdown.push({
      bracket: bracket.label,
      amount: Math.round(taxable * 100) / 100,
      tax: Math.round(tax * 100) / 100,
      rate: bracket.rate,
    });
    totalTax += tax;
    remaining -= taxable;
  }

  const roundedTax = Math.round(totalTax * 100) / 100;
  return {
    grossAmount,
    taxableAmount: grossAmount,
    taxAmount: roundedTax,
    effectiveRate: grossAmount > 0 ? roundedTax / grossAmount : 0,
    directiveRateUsed: false,
    breakdown,
  };
}

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
