/**
 * Flat GL-line export — the row contract: column order, the mapping from one
 * query row to one export row, the fiscal calendar and the CSV cell rules.
 * Pure: no query lives here (those are in glLineExportService.ts and
 * glLineExportTables.ts).
 *
 * VAT. IsaFlow posts VAT as its OWN line to the VAT control account (subtype
 * vat_input / vat_output), not as a column of the expense line. So in v1 each
 * row's VAT_Amount is 0.00 and Amount_Incl_VAT = Amount_Excl_VAT, and the VAT
 * row carries the VAT itself with its VAT_Code. That keeps both §9.3 integrity
 * rules true on every row (incl = excl + VAT; every Txn balances) without
 * guessing which VAT line belongs to which base line. Pairing them is v2.
 */

import type { DbRow } from '@/types/db';
import { fiscalYearStart } from '@/modules/accounting/services/gl/fiscalYearBasis';

export const GL_LINE_EXPORT_SCHEMA_VERSION = 'isaflow-gl-lines-1.0';

/** Fixed column order — the contract. Append only; never reorder. */
export const GL_LINE_EXPORT_COLUMNS = [
  'Line_ID',
  'Txn_ID',
  'Entity',
  'Journal_No',
  'Journal_Type',
  'Journal_Source',
  'Source_System',
  'Source_Ref',
  'Document_No',
  'Linked_Document_Count',
  'Reverses_Txn_ID',
  'Created_By',
  'Created_At',
  'Modified_At',
  'Posting_Status',
  'Period_Locked',
  'Txn_Date',
  'Period',
  'FY',
  'FY_Period_No',
  'Amount_Excl_VAT',
  'VAT_Amount',
  'Amount_Incl_VAT',
  'VAT_Code',
  'Currency',
  'Debit_Credit',
  'GL_Account_Code',
  'GL_Account_Name',
  'GL_Account_Type',
  'Account_Class',
  'Account_Category',
  'Statement_Line',
  'Statement_Group',
  'Cash_Class',
  'Capex_Opex_Flag',
  'Is_Cash_Movement',
  'CC1_Code',
  'CC1_Name',
  'CC2_Code',
  'CC2_Name',
  'CC2_Parent_Code',
  'BU_Code',
  'BU_Name',
  'BU_Division',
  'Counterparty_ID',
  'Counterparty_Name',
  'Counterparty_Type',
  'Bank_Account_Code',
  'Bank_Account_Name',
  'Payment_Ref',
  'Line_Description',
  'Schema_Version',
] as const;
export type GlLineExportColumn = (typeof GL_LINE_EXPORT_COLUMNS)[number];
export type ExportValue = string | number | boolean | null;
export type GlLineExportRow = Record<GlLineExportColumn, ExportValue>;

/** What every row of one company's export carries: its name and fiscal basis. */
export interface ExportEntity {
  name: string;
  /** Month 1-12 the company's financial year starts in (companies.financial_year_start). */
  fyStartMonth: number;
}

const JOURNAL_TYPE_BY_SOURCE: Record<string, string> = {
  manual: 'Journal',
  auto_recurring: 'Journal',
  auto_invoice: 'Customer invoice',
  auto_supplier_invoice: 'Supplier invoice',
  auto_grn: 'Supplier invoice',
  auto_purchase_order: 'Supplier invoice',
  auto_expense_claim: 'Supplier invoice',
  auto_expense_receipt: 'Supplier invoice',
  auto_payment: 'Bank',
  auto_supplier_payment: 'Bank',
  auto_batch_payment: 'Bank',
  auto_bank_recon: 'Bank',
  auto_bank_transfer: 'Bank',
  auto_payroll: 'Payroll',
  auto_depreciation: 'Depreciation',
  auto_asset_disposal: 'Asset',
  auto_asset_expense: 'Asset',
  auto_loan_payment: 'Loan',
  auto_write_off: 'Correction',
  auto_adjustment: 'Correction',
  auto_vat_adjustment: 'VAT',
  auto_vat_submission: 'VAT',
  auto_vat_late_claim: 'VAT',
  auto_migration: 'Migration',
  auto_gl_import: 'Migration',
  year_end: 'Year end',
};

/** Brief §4.1 Journal_Type from the journal source (and, for a credit note, its side). */
export function journalTypeOf(source: string | null, creditNoteType: string | null): string {
  if (source === 'auto_credit_note') {
    return creditNoteType === 'supplier' ? 'Supplier credit note' : 'Customer credit note';
  }
  return JOURNAL_TYPE_BY_SOURCE[source ?? ''] ?? 'Journal';
}

const STATUS_LABEL: Record<string, string> = { posted: 'Posted', draft: 'Draft', reversed: 'Reversed' };

/**
 * Period (first of month), FY and FY period number for a YYYY-MM-DD date, on
 * the company's own financial year (`fyStartMonth`, from
 * companies.financial_year_start). The FY is named by the calendar year it ENDS
 * in: on a March year 2025-03-17 is FY26 period 1 and 2026-02-28 is FY26 period
 * 12; on a July year 2025-07-01 is FY26 period 1; on a January year the FY is
 * the calendar year itself.
 */
export function fiscalOf(date: string, fyStartMonth: number): { period: string; fy: string; fyPeriodNo: number } {
  const start = fiscalYearStart(date, fyStartMonth);
  const startYear = Number(start.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const endYear = fyStartMonth === 1 ? startYear : startYear + 1;
  return {
    period: `${date.slice(0, 7)}-01`,
    fy: `FY${String(endYear % 100).padStart(2, '0')}`,
    fyPeriodNo: ((month - fyStartMonth + 12) % 12) + 1,
  };
}

export const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

export const toNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

export function isoDate(v: unknown): string {
  if (v instanceof Date) {
    // DATE columns arrive as local-midnight Dates from node-postgres; format
    // the local calendar day, not the UTC one, or SAST shifts it back a day.
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

function isoTimestamp(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** One raw query row → the contract row. */
export function toExportRow(r: DbRow, entity: ExportEntity): GlLineExportRow {
  const signed = Math.round((toNum(r.debit) - toNum(r.credit)) * 100) / 100 || 0;
  const txnDate = isoDate(r.entry_date);
  const { period, fy, fyPeriodNo } = fiscalOf(txnDate, entity.fyStartMonth);
  const isCash = r.is_cash === true;
  return {
    Line_ID: String(r.line_id),
    Txn_ID: str(r.entry_number) ?? String(r.entry_id),
    Entity: entity.name,
    Journal_No: str(r.entry_number),
    Journal_Type: journalTypeOf(str(r.source), str(r.cn_type)),
    Journal_Source: str(r.source),
    Source_System: 'IsaFlow',
    Source_Ref: str(r.reference),
    Document_No: str(r.document_no),
    Linked_Document_Count: toNum(r.linked_document_count),
    Reverses_Txn_ID: str(r.reverses_entry_number),
    Created_By: str(r.created_by_name),
    Created_At: isoTimestamp(r.created_at),
    Modified_At: isoTimestamp(r.updated_at),
    Posting_Status: STATUS_LABEL[String(r.status)] ?? String(r.status),
    Period_Locked: r.period_locked === true,
    Txn_Date: txnDate,
    Period: period,
    FY: fy,
    FY_Period_No: fyPeriodNo,
    Amount_Excl_VAT: signed,
    VAT_Amount: 0,
    Amount_Incl_VAT: signed,
    VAT_Code: str(r.vat_type),
    Currency: 'ZAR',
    Debit_Credit: signed < 0 ? 'CR' : 'DR',
    GL_Account_Code: str(r.account_code),
    GL_Account_Name: str(r.account_name),
    GL_Account_Type: str(r.account_type),
    Account_Class: str(r.report_class),
    Account_Category: str(r.report_category),
    Statement_Line: str(r.statement_line),
    Statement_Group: str(r.statement_group),
    Cash_Class: str(r.cash_class),
    Capex_Opex_Flag: str(r.capex_opex),
    Is_Cash_Movement: isCash,
    CC1_Code: str(r.cc1_code),
    CC1_Name: str(r.cc1_name),
    CC2_Code: str(r.cc2_code),
    CC2_Name: str(r.cc2_name),
    CC2_Parent_Code: str(r.cc2_parent_code),
    BU_Code: str(r.bu_code),
    BU_Name: str(r.bu_name),
    BU_Division: str(r.bu_division),
    Counterparty_ID: str(r.counterparty_id),
    Counterparty_Name: str(r.counterparty_name),
    Counterparty_Type: str(r.counterparty_type),
    Bank_Account_Code: isCash ? str(r.account_code) : null,
    Bank_Account_Name: isCash ? str(r.account_name) : null,
    Payment_Ref: str(r.payment_ref),
    Line_Description: str(r.line_description),
    Schema_Version: GL_LINE_EXPORT_SCHEMA_VERSION,
  };
}

/** Columns written as integers rather than two-decimal amounts. */
const INTEGER_COLUMNS: ReadonlySet<string> = new Set(['FY_Period_No', 'Linked_Document_Count']);

/**
 * One CSV cell per §9.1: numbers with a point and two decimals, never quoted or
 * formula-guarded (the shared `csvCell` prefixes a leading minus with a quote,
 * which turns every credit into text); booleans as true/false; blank for null.
 * Text is quoted, doubled-quote escaped, and formula-guarded: a cell opening
 * with = + - @ | tab or CR gets a leading apostrophe, so a spreadsheet shows it
 * as text instead of evaluating it. That changes the cell's text by one leading
 * character; the JSON over MCP carries the value unguarded.
 */
export function exportCell(column: string, value: ExportValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return INTEGER_COLUMNS.has(column) ? String(value) : value.toFixed(2);
  const s = /^[=+\-@|\t\r]/.test(value) ? `'${value}` : value;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvLine(columns: readonly string[], row: Readonly<Record<string, ExportValue>>): string {
  return columns.map((c) => exportCell(c, row[c])).join(',');
}
