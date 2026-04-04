/**
 * GL Import Service — WS-6.3 Excel Import Wizard
 * Validates and imports journal entries from spreadsheet uploads.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { VatType } from '../types/gl.types';
type Row = Record<string, unknown>;


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
    // Load chart of accounts for this company
    const accountRows = (await sql`
      SELECT account_code, id
      FROM gl_accounts
      WHERE company_id = ${companyId}::UUID
        AND is_active = true
    `) as Row[];
    const accountMap = new Map<string, string>(
      accountRows.map((r: Row) => [String(r.account_code), String(r.id)]),
    );

    // Load open fiscal periods
    const periodRows = (await sql`
      SELECT start_date, end_date
      FROM fiscal_periods
      WHERE company_id = ${companyId}::UUID
        AND status = 'open'
      ORDER BY start_date
    `) as Row[];

    // Load cost centres
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

      // Description required
      if (!row.description || row.description.trim() === '') {
        errors.push('Description is required');
      }

      // Date validation
      const parsedDate = parseDate(row.date);
      if (!parsedDate) {
        errors.push(`Invalid date: "${row.date}" — expected YYYY-MM-DD`);
      } else {
        // Check if date falls within an open fiscal period
        const inOpenPeriod = periodRows.some((p: Row) => {
          const start = new Date(String(p.start_date));
          const end = new Date(String(p.end_date));
          return parsedDate >= start && parsedDate <= end;
        });
        if (!inOpenPeriod) {
          warnings.push(`Date ${row.date} does not fall within an open fiscal period`);
        }
      }

      // Account code validation
      if (!row.accountCode || row.accountCode.trim() === '') {
        errors.push('Account code is required');
      } else if (!accountMap.has(String(row.accountCode).trim())) {
        errors.push(`Account code "${row.accountCode}" not found in chart of accounts`);
      }

      // Debit / credit validation
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

      // VAT code validation (optional)
      if (row.vatCode && row.vatCode.trim() !== '') {
        const code = row.vatCode.trim() as VatType;
        if (!VALID_VAT_CODES.includes(code)) {
          errors.push(
            `Invalid VAT code "${row.vatCode}". Valid codes: ${VALID_VAT_CODES.join(', ')}`,
          );
        }
      }

      // Cost centre validation (optional)
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

    // For balanced check, only consider valid rows
    const diff = Math.abs(totalDebit - totalCredit);
    const isBalanced = diff < 0.005; // tolerance for floating point

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

export async function importJournalEntries(
  companyId: string,
  rows: ImportRow[],
  userId: string,
  postImmediately: boolean,
): Promise<ImportResult> {
  try {
    // Load account code → id mapping
    const accountRows = (await sql`
      SELECT account_code, id
      FROM gl_accounts
      WHERE company_id = ${companyId}::UUID
        AND is_active = true
    `) as Row[];
    const accountMap = new Map<string, string>(
      accountRows.map((r: Row) => [String(r.account_code), String(r.id)]),
    );

    // Load cost centre code → id mapping
    const ccRows = (await sql`
      SELECT code, id
      FROM cost_centres
      WHERE company_id = ${companyId}::UUID
        AND is_active = true
    `) as Row[];
    const ccMap = new Map<string, string>(
      ccRows.map((r: Row) => [String(r.code).toLowerCase(), String(r.id)]),
    );

    // Group rows into journal entries: same date + same reference = one entry
    const grouped = new Map<string, ImportRow[]>();
    for (const row of rows) {
      const key = `${row.date}||${row.reference || ''}`;
      const group = grouped.get(key) ?? [];
      group.push(row);
      grouped.set(key, group);
    }

    let entriesCreated = 0;
    let linesCreated = 0;
    let totalValue = 0;
    const status = postImmediately ? 'posted' : 'draft';

    for (const [, groupRows] of grouped) {
      const firstRow = groupRows[0]!;

      // Find fiscal period for entry date
      const periodRows = (await sql`
        SELECT id FROM fiscal_periods
        WHERE company_id = ${companyId}::UUID
          AND start_date <= ${firstRow.date}::DATE
          AND end_date >= ${firstRow.date}::DATE
        LIMIT 1
      `) as Row[];
      const fiscalPeriodId = periodRows.length > 0 ? String(periodRows[0]!.id) : null;

      const description = firstRow.reference
        ? `${firstRow.reference}: ${firstRow.description}`
        : firstRow.description;

      const postedBy = postImmediately ? userId : null;

      const entryInsert = (await sql`
        INSERT INTO gl_journal_entries (
          company_id, entry_date, fiscal_period_id, description,
          source, created_by, status,
          posted_by, posted_at
        ) VALUES (
          ${companyId}::UUID,
          ${firstRow.date}::DATE,
          ${fiscalPeriodId}::UUID,
          ${description},
          'import',
          ${userId}::UUID,
          ${status},
          ${postedBy}::UUID,
          ${postImmediately ? sql`NOW()` : sql`NULL`}
        )
        RETURNING id
      `) as Row[];

      const entryId = String(entryInsert[0]!.id);
      entriesCreated++;

      for (const row of groupRows) {
        const accountId = accountMap.get(String(row.accountCode).trim());
        if (!accountId) continue; // already validated upstream

        const ccId = row.costCentre
          ? (ccMap.get(row.costCentre.trim().toLowerCase()) ?? null)
          : null;

        const vatType = (row.vatCode?.trim() as VatType) || null;

        await sql`
          INSERT INTO gl_journal_lines (
            journal_entry_id, gl_account_id, debit, credit,
            description, vat_type, cost_center_id
          ) VALUES (
            ${entryId}::UUID,
            ${accountId}::UUID,
            ${Number(row.debit) || 0},
            ${Number(row.credit) || 0},
            ${row.description},
            ${vatType},
            ${ccId}::UUID
          )
        `;

        linesCreated++;
        totalValue += Number(row.debit) || 0;
      }
    }

    log.info('Imported journal entries', {
      companyId, entriesCreated, linesCreated, totalValue, postImmediately,
    }, 'gl-import');

    return { entriesCreated, linesCreated, totalValue };
  } catch (err) {
    log.error('Failed to import journal entries', { error: err }, 'gl-import');
    throw err;
  }
}
