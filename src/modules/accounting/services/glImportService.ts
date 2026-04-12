/**
 * GL Import Service — WS-6.3 Excel Import Wizard
 * Validates and imports journal entries from spreadsheet uploads.
 * Import execution split to glImportExecuteService.ts.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { VatType } from '../types/gl.types';
type Row = DbRow;


export interface ImportRow {
  date: string;          // YYYY-MM-DD
  accountCode: string;   // Must exist in gl_accounts for this company
  description: string;
  reference?: string;
  debit: number;
  credit: number;
  vatCode?: string;
  costCentre?: string;
}

export interface ValidationResult {
  row: number;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ValidationSummary {
  validations: ValidationResult[];
  validCount: number;
  errorCount: number;
  warningCount: number;
  totalDebit: number;
  totalCredit: number;
  isBalanced: boolean;
}

export interface ImportResult {
  entriesCreated: number;
  linesCreated: number;
  totalValue: number;
}

const VALID_VAT_CODES: VatType[] = [
  'standard', 'zero_rated', 'exempt', 'capital_goods',
  'export', 'imported', 'reverse_charge', 'bad_debt', 'no_vat',
];

function parseDate(dateStr: string): Date | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d;
}

export async function validateImportRows(
  companyId: string,
  rows: ImportRow[],
): Promise<ValidationSummary> {
  try {
    const accountRows = (await sql`
      SELECT account_code, id
      FROM gl_accounts
      WHERE company_id = ${companyId}::UUID
        AND is_active = true
    `) as Row[];
    const accountMap = new Map<string, string>(
      accountRows.map((r: Row) => [String(r.account_code), String(r.id)]),
    );

    const periodRows = (await sql`
      SELECT start_date, end_date
      FROM fiscal_periods
      WHERE company_id = ${companyId}::UUID
        AND status = 'open'
      ORDER BY start_date
    `) as Row[];

    const ccRows = (await sql`
      SELECT code, id
      FROM cost_centres
      WHERE company_id = ${companyId}::UUID
        AND is_active = true
    `) as Row[];
    const ccSet = new Set<string>(ccRows.map((r: Row) => String(r.code).toLowerCase()));

    const validations: ValidationResult[] = [];
    let totalDebit = 0;
    let totalCredit = 0;
    let validCount = 0;
    let errorCount = 0;
    let warningCount = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const errors: string[] = [];
      const warnings: string[] = [];
      const rowNum = i + 2; // 1-indexed + header row

      if (!row.description || row.description.trim() === '') {
        errors.push('Description is required');
      }

      const parsedDate = parseDate(row.date);
      if (!parsedDate) {
        errors.push(`Invalid date: "${row.date}" — expected YYYY-MM-DD`);
      } else {
        const inOpenPeriod = periodRows.some((p: Row) => {
          const start = new Date(String(p.start_date));
          const end = new Date(String(p.end_date));
          return parsedDate >= start && parsedDate <= end;
        });
        if (!inOpenPeriod) {
          warnings.push(`Date ${row.date} does not fall within an open fiscal period`);
        }
      }

      if (!row.accountCode || row.accountCode.trim() === '') {
        errors.push('Account code is required');
      } else if (!accountMap.has(String(row.accountCode).trim())) {
        errors.push(`Account code "${row.accountCode}" not found in chart of accounts`);
      }

      const debit = Number(row.debit) || 0;
      const credit = Number(row.credit) || 0;

      if (debit < 0) errors.push('Debit cannot be negative');
      if (credit < 0) errors.push('Credit cannot be negative');

      if (debit > 0 && credit > 0) {
        errors.push('Debit and credit cannot both be greater than zero on the same line');
      }
      if (debit === 0 && credit === 0) {
        errors.push('At least one of debit or credit must be greater than zero');
      }

      if (row.vatCode && row.vatCode.trim() !== '') {
        const code = row.vatCode.trim() as VatType;
        if (!VALID_VAT_CODES.includes(code)) {
          errors.push(
            `Invalid VAT code "${row.vatCode}". Valid codes: ${VALID_VAT_CODES.join(', ')}`,
          );
        }
      }

      if (row.costCentre && row.costCentre.trim() !== '') {
        if (!ccSet.has(row.costCentre.trim().toLowerCase())) {
          warnings.push(`Cost centre "${row.costCentre}" not found — will be ignored`);
        }
      }

      const valid = errors.length === 0;
      if (valid) {
        validCount++;
        totalDebit += debit;
        totalCredit += credit;
      } else {
        errorCount++;
      }
      if (warnings.length > 0) warningCount++;

      validations.push({ row: rowNum, valid, errors, warnings });
    }

    const diff = Math.abs(totalDebit - totalCredit);
    const isBalanced = diff < 0.005;

    return {
      validations,
      validCount,
      errorCount,
      warningCount,
      totalDebit,
      totalCredit,
      isBalanced,
    };
  } catch (err) {
    log.error('Failed to validate import rows', { error: err }, 'gl-import');
    throw err;
  }
}

// Import execution split to glImportExecuteService.ts — re-exported for backward compat
export { importJournalEntries } from './glImportExecuteService';
