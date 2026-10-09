/**
 * Flat GL-line export — v1 of the ledger brief's §4 field contract, shaped per
 * its §9 export contract (one row per journal line, fixed column order, ISO
 * dates, decimals with a point and no separators, blank means blank).
 *
 * GRAIN. One row per `gl_journal_lines` row. A transaction (journal entry) with
 * four lines is four rows sharing a Txn_ID; debits positive, credits negative,
 * so every posted Txn_ID sums to zero and so does the file (the control total).
 *
 * VAT. IsaFlow posts VAT as its OWN line to the VAT control account (subtype
 * vat_input / vat_output), not as a column of the expense line. So in v1 each
 * row's VAT_Amount is 0.00 and Amount_Incl_VAT = Amount_Excl_VAT, and the VAT
 * row carries the VAT itself with its VAT_Code. That keeps both §9.3 integrity
 * rules true on every row (incl = excl + VAT; every Txn balances) without
 * guessing which VAT line belongs to which base line. Pairing them is v2.
 *
 * COUNTERPARTY AND DOCUMENT. The document tables hold the journal id
 * (`gl_journal_entry_id`), not the other way round, so each page resolves its
 * entries against supplier invoices, customer invoices, credit notes, supplier
 * payments, customer receipts and the bank line a journal line was matched to —
 * restricted to the entries on the page so a page never scans the whole
 * document history. A manual journal has no counterparty, and says so (blank).
 *
 * WHAT IS NOT HERE (v2 per the plan): loan Movement_Type, Revenue_State,
 * retention, Phase/Zone/PON, payroll Pay_Component, stock movements, card
 * holder, and per-row VAT pairing.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { CASH_SUBTYPES } from '@/modules/accounting/services/gl/accountSubtypes';

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

export type GlLineExportStatus = 'posted' | 'all';

export interface GlLineExportOptions {
  /** Inclusive YYYY-MM-DD; omitted = from the first line (full history, §9.2). */
  dateFrom?: string;
  /** Inclusive YYYY-MM-DD; omitted = to the last line. */
  dateTo?: string;
  /** `all` (default) also exports draft and reversed journals, labelled; `posted` only those that feed the statements. */
  status?: GlLineExportStatus;
}

/** Keyset position: the last row of the previous page. */
export interface GlLineExportCursor {
  entryDate: string;
  entryId: string;
  lineId: string;
}

export const GL_LINE_EXPORT_MAX_PAGE = 5000;

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
 * Period (first of month), FY and FY period number for a YYYY-MM-DD date. The
 * financial year runs March–February and is named by the calendar year it
 * ENDS in: 2025-03-17 is FY26 period 1, 2026-02-28 is FY26 period 12.
 */
export function fiscalOf(date: string): { period: string; fy: string; fyPeriodNo: number } {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const endYear = month >= 3 ? year + 1 : year;
  return {
    period: `${date.slice(0, 7)}-01`,
    fy: `FY${String(endYear % 100).padStart(2, '0')}`,
    fyPeriodNo: month >= 3 ? month - 2 : month + 10,
  };
}

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

const toNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
};

function isoDate(v: unknown): string {
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

/** One raw query row → the contract row. Exported for tests. */
export function toExportRow(r: DbRow, entityName: string): GlLineExportRow {
  const signed = Math.round((toNum(r.debit) - toNum(r.credit)) * 100) / 100 || 0;
  const txnDate = isoDate(r.entry_date);
  const { period, fy, fyPeriodNo } = fiscalOf(txnDate);
  const isCash = r.is_cash === true;
  return {
    Line_ID: String(r.line_id),
    Txn_ID: str(r.entry_number) ?? String(r.entry_id),
    Entity: entityName,
    Journal_No: str(r.entry_number),
    Journal_Type: journalTypeOf(str(r.source), str(r.cn_type)),
    Journal_Source: str(r.source),
    Source_System: 'IsaFlow',
    Source_Ref: str(r.reference),
    Document_No: str(r.document_no),
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

/** The entity name the rows carry. */
export async function getExportEntityName(companyId: string): Promise<string> {
  const rows = (await sql`SELECT name FROM companies WHERE id = ${companyId}::UUID LIMIT 1`) as DbRow[];
  return String(rows[0]?.name ?? '');
}

/**
 * One keyset page of export rows, ordered (Txn_Date, entry id, line id) — a
 * total order, so paging to exhaustion visits every line exactly once.
 */
export async function fetchGlLineExportPage(
  companyId: string,
  opts: GlLineExportOptions,
  cursor: GlLineExportCursor | null,
  limit: number,
): Promise<DbRow[]> {
  const from = opts.dateFrom ?? null;
  const to = opts.dateTo ?? null;
  const postedOnly = (opts.status ?? 'all') === 'posted';
  const cDate = cursor?.entryDate ?? null;
  const cEntry = cursor?.entryId ?? null;
  const cLine = cursor?.lineId ?? null;
  const pageSize = clampPage(limit);

  return (await sql`
    WITH page AS (
      SELECT jl.id AS line_id, jl.journal_entry_id AS entry_id, je.entry_date,
             jl.gl_account_id, jl.debit, jl.credit, jl.vat_type, jl.description AS line_description,
             jl.cc1_id, jl.cc2_id, jl.bu_id
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND (${from}::DATE IS NULL OR je.entry_date >= ${from}::DATE)
        AND (${to}::DATE IS NULL OR je.entry_date <= ${to}::DATE)
        AND (NOT ${postedOnly}::BOOLEAN OR je.status = 'posted')
        AND (${cDate}::DATE IS NULL
             OR (je.entry_date, jl.journal_entry_id, jl.id) > (${cDate}::DATE, ${cEntry}::UUID, ${cLine}::UUID))
      ORDER BY je.entry_date, jl.journal_entry_id, jl.id
      LIMIT ${pageSize}
    ),
    entries AS (SELECT DISTINCT entry_id FROM page),
    si AS (
      SELECT DISTINCT ON (si.gl_journal_entry_id) si.gl_journal_entry_id AS entry_id,
             si.supplier_id, si.invoice_number
      FROM supplier_invoices si
      WHERE si.company_id = ${companyId}::UUID AND si.gl_journal_entry_id IN (SELECT entry_id FROM entries)
      ORDER BY si.gl_journal_entry_id, si.id
    ),
    ci AS (
      SELECT DISTINCT ON (ci.gl_journal_entry_id) ci.gl_journal_entry_id AS entry_id,
             COALESCE(ci.client_id, ci.customer_id) AS customer_id, ci.invoice_number
      FROM customer_invoices ci
      WHERE ci.company_id = ${companyId}::UUID AND ci.gl_journal_entry_id IN (SELECT entry_id FROM entries)
      ORDER BY ci.gl_journal_entry_id, ci.id
    ),
    cn AS (
      SELECT DISTINCT ON (cn.gl_journal_entry_id) cn.gl_journal_entry_id AS entry_id,
             cn.type AS cn_type, cn.supplier_id, cn.client_id AS customer_id, cn.credit_note_number
      FROM credit_notes cn
      WHERE cn.company_id = ${companyId}::UUID AND cn.gl_journal_entry_id IN (SELECT entry_id FROM entries)
      ORDER BY cn.gl_journal_entry_id, cn.id
    ),
    sp AS (
      SELECT DISTINCT ON (sp.gl_journal_entry_id) sp.gl_journal_entry_id AS entry_id,
             sp.supplier_id, sp.payment_number
      FROM supplier_payments sp
      WHERE sp.company_id = ${companyId}::UUID AND sp.gl_journal_entry_id IN (SELECT entry_id FROM entries)
      ORDER BY sp.gl_journal_entry_id, sp.id
    ),
    cp AS (
      SELECT DISTINCT ON (cp.gl_journal_entry_id) cp.gl_journal_entry_id AS entry_id,
             cp.client_id AS customer_id, cp.payment_number
      FROM customer_payments cp
      WHERE cp.company_id = ${companyId}::UUID AND cp.gl_journal_entry_id IN (SELECT entry_id FROM entries)
      ORDER BY cp.gl_journal_entry_id, cp.id
    ),
    bt AS (
      SELECT DISTINCT ON (ml.journal_entry_id) ml.journal_entry_id AS entry_id,
             bt.reference, bt.allocated_entity_name
      FROM bank_transactions bt
      JOIN gl_journal_lines ml ON ml.id = bt.matched_journal_line_id
      WHERE bt.company_id = ${companyId}::UUID AND ml.journal_entry_id IN (SELECT entry_id FROM entries)
      ORDER BY ml.journal_entry_id, bt.id
    ),
    ent AS (
      SELECT je.id AS entry_id, je.entry_number, je.source, je.status, je.reference,
             je.external_document_number, je.created_at, je.updated_at,
             rv.entry_number AS reverses_entry_number,
             COALESCE(public.approval_company_member_name(je.company_id, je.created_by::TEXT),
                      je.created_by::TEXT) AS created_by_name,
             COALESCE(fp.status IN ('closed', 'locked'), false) AS period_locked
      FROM gl_journal_entries je
      LEFT JOIN gl_journal_entries rv ON rv.id = je.reversal_of_id AND rv.company_id = je.company_id
      -- By date, not fiscal_period_id: older rows have no period id (501 did
      -- no backfill), and 502 forbids overlapping periods, so this is unique.
      LEFT JOIN fiscal_periods fp ON fp.company_id = je.company_id
        AND je.entry_date BETWEEN fp.start_date AND fp.end_date
      WHERE je.company_id = ${companyId}::UUID AND je.id IN (SELECT entry_id FROM entries)
    )
    SELECT p.line_id, p.entry_id, p.entry_date, p.debit, p.credit, p.vat_type, p.line_description,
           e.entry_number, e.source, e.status, e.reference, e.created_at, e.updated_at,
           e.reverses_entry_number, e.created_by_name, e.period_locked,
           ga.account_code, ga.account_name, ga.account_type,
           ga.report_class, ga.report_category, ga.statement_line, ga.statement_group,
           ga.cash_class, ga.capex_opex,
           (ga.account_subtype = ANY(${CASH_SUBTYPES as string[]}::TEXT[])) AS is_cash,
           c1.code AS cc1_code, c1.name AS cc1_name,
           c2.code AS cc2_code, c2.name AS cc2_name, c2p.code AS cc2_parent_code,
           bu.code AS bu_code, bu.name AS bu_name, bu.division AS bu_division,
           cn.cn_type,
           COALESCE(si.invoice_number, ci.invoice_number, cn.credit_note_number,
                    sp.payment_number, cp.payment_number, e.external_document_number) AS document_no,
           COALESCE(sp.payment_number, cp.payment_number, bt.reference) AS payment_ref,
           CASE
             WHEN COALESCE(si.supplier_id, cn.supplier_id, sp.supplier_id) IS NOT NULL THEN 'Supplier'
             WHEN COALESCE(ci.customer_id, cn.customer_id, cp.customer_id) IS NOT NULL THEN 'Customer'
             WHEN bt.allocated_entity_name IS NOT NULL THEN 'Other'
           END AS counterparty_type,
           COALESCE(si.supplier_id, cn.supplier_id, sp.supplier_id,
                    ci.customer_id, cn.customer_id, cp.customer_id)::TEXT AS counterparty_id,
           COALESCE(s.company_name, s.name, cu.name, bt.allocated_entity_name) AS counterparty_name
    FROM page p
    JOIN ent e ON e.entry_id = p.entry_id
    JOIN gl_accounts ga ON ga.id = p.gl_account_id
    LEFT JOIN cost_centres c1 ON c1.id = p.cc1_id AND c1.company_id = ${companyId}::UUID
    LEFT JOIN cost_centres c2 ON c2.id = p.cc2_id AND c2.company_id = ${companyId}::UUID
    LEFT JOIN cost_centres c2p ON c2p.id = c2.parent_id AND c2p.company_id = ${companyId}::UUID
    LEFT JOIN business_units bu ON bu.id = p.bu_id AND bu.company_id = ${companyId}::UUID
    LEFT JOIN si ON si.entry_id = p.entry_id
    LEFT JOIN ci ON ci.entry_id = p.entry_id
    LEFT JOIN cn ON cn.entry_id = p.entry_id
    LEFT JOIN sp ON sp.entry_id = p.entry_id
    LEFT JOIN cp ON cp.entry_id = p.entry_id
    LEFT JOIN bt ON bt.entry_id = p.entry_id
    LEFT JOIN suppliers s ON s.id = COALESCE(si.supplier_id, cn.supplier_id, sp.supplier_id)
      AND s.company_id = ${companyId}::UUID
    LEFT JOIN customers cu ON cu.id = COALESCE(ci.customer_id, cn.customer_id, cp.customer_id)
      AND cu.company_id = ${companyId}::UUID
    ORDER BY p.entry_date, p.entry_id, p.line_id
  `) as DbRow[];
}

export function clampPage(limit: number): number {
  if (!Number.isFinite(limit)) return GL_LINE_EXPORT_MAX_PAGE;
  return Math.max(1, Math.min(GL_LINE_EXPORT_MAX_PAGE, Math.floor(limit)));
}

/** The cursor after a page, or null when the page was the last. */
export function nextCursorOf(rows: readonly DbRow[], limit: number): GlLineExportCursor | null {
  if (rows.length === 0 || rows.length < clampPage(limit)) return null;
  const last = rows[rows.length - 1]!;
  return { entryDate: isoDate(last.entry_date), entryId: String(last.entry_id), lineId: String(last.line_id) };
}

/** §9.2 file header facts and §9.3 integrity checks, over the same window as the rows. */
export interface GlLineExportSummary {
  schemaVersion: string;
  rowCount: number;
  postedRowCount: number;
  txnCount: number;
  /** Σ Amount_Excl_VAT over Posted rows — zero on a balanced ledger. */
  controlTotal: number;
  /** Posted transactions whose lines do not sum to zero. Must be 0. */
  unbalancedTxnCount: number;
  firstTxnDate: string | null;
  lastTxnDate: string | null;
}

export async function getGlLineExportSummary(
  companyId: string,
  opts: GlLineExportOptions,
): Promise<GlLineExportSummary> {
  const from = opts.dateFrom ?? null;
  const to = opts.dateTo ?? null;
  const postedOnly = (opts.status ?? 'all') === 'posted';
  // The SAME predicate as fetchGlLineExportPage's `page` CTE, so rowCount is
  // the number of rows paging to exhaustion yields.
  const [row] = (await sql`
    WITH lines AS (
      SELECT jl.journal_entry_id, je.status, je.entry_date, jl.debit, jl.credit
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE je.company_id = ${companyId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND (${from}::DATE IS NULL OR je.entry_date >= ${from}::DATE)
        AND (${to}::DATE IS NULL OR je.entry_date <= ${to}::DATE)
        AND (NOT ${postedOnly}::BOOLEAN OR je.status = 'posted')
    ),
    txn AS (
      SELECT journal_entry_id, SUM(debit - credit) AS net
      FROM lines WHERE status = 'posted' GROUP BY journal_entry_id
    )
    SELECT
      (SELECT COUNT(*) FROM lines) AS row_count,
      (SELECT COUNT(*) FROM lines WHERE status = 'posted') AS posted_row_count,
      (SELECT COUNT(DISTINCT journal_entry_id) FROM lines) AS txn_count,
      (SELECT COALESCE(SUM(debit - credit), 0) FROM lines WHERE status = 'posted') AS control_total,
      (SELECT COUNT(*) FROM txn WHERE net <> 0) AS unbalanced_txn_count,
      (SELECT MIN(entry_date) FROM lines) AS first_date,
      (SELECT MAX(entry_date) FROM lines) AS last_date
  `) as DbRow[];
  return {
    schemaVersion: GL_LINE_EXPORT_SCHEMA_VERSION,
    rowCount: toNum(row?.row_count),
    postedRowCount: toNum(row?.posted_row_count),
    txnCount: toNum(row?.txn_count),
    controlTotal: Math.round(toNum(row?.control_total) * 100) / 100 || 0,
    unbalancedTxnCount: toNum(row?.unbalanced_txn_count),
    firstTxnDate: row?.first_date == null ? null : isoDate(row.first_date),
    lastTxnDate: row?.last_date == null ? null : isoDate(row.last_date),
  };
}

/** Columns written as integers rather than two-decimal amounts. */
const INTEGER_COLUMNS: ReadonlySet<string> = new Set(['FY_Period_No']);

/**
 * One CSV cell per §9.1: numbers with a point and two decimals, never quoted or
 * formula-guarded (the shared `csvCell` prefixes a leading minus with a quote,
 * which turns every credit into text); booleans as true/false; blank for null.
 * Text is quoted, doubled-quote escaped, and formula-guarded.
 */
export function exportCell(column: string, value: ExportValue | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return INTEGER_COLUMNS.has(column) ? String(value) : value.toFixed(2);
  const s = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${s.replace(/"/g, '""')}"`;
}

export function csvLine(columns: readonly string[], row: Readonly<Record<string, ExportValue>>): string {
  return columns.map((c) => exportCell(c, row[c])).join(',');
}

// ── Dimension tables (§9.1: "plus the dimension tables … one file per table") ──

export const GL_EXPORT_TABLES = ['lines', 'accounts', 'cost_centres', 'business_units', 'counterparties'] as const;
export type GlExportTable = (typeof GL_EXPORT_TABLES)[number];

export function isGlExportTable(v: unknown): v is GlExportTable {
  return typeof v === 'string' && (GL_EXPORT_TABLES as readonly string[]).includes(v);
}

export interface DimensionTable {
  columns: string[];
  rows: Array<Record<string, ExportValue>>;
}

/** A master table for the export. Every code a line carries resolves to a row here. */
export async function getExportDimensionTable(
  companyId: string,
  table: Exclude<GlExportTable, 'lines'>,
): Promise<DimensionTable> {
  if (table === 'accounts') {
    const rows = (await sql`
      SELECT account_code, account_name, account_type, account_subtype, report_class, report_category,
             statement_line, statement_group, cash_class, capex_opex, is_active,
             (account_subtype = ANY(${CASH_SUBTYPES as string[]}::TEXT[])) AS is_bank
      FROM gl_accounts WHERE company_id = ${companyId}::UUID ORDER BY account_code
    `) as DbRow[];
    return {
      columns: ['GL_Account_Code', 'GL_Account_Name', 'GL_Account_Type', 'Account_Subtype', 'Account_Class',
        'Account_Category', 'Statement_Line', 'Statement_Group', 'Cash_Class', 'Capex_Opex_Flag', 'Is_Bank',
        'Is_Active', 'Schema_Version'],
      rows: rows.map((r) => ({
        GL_Account_Code: str(r.account_code), GL_Account_Name: str(r.account_name),
        GL_Account_Type: str(r.account_type), Account_Subtype: str(r.account_subtype),
        Account_Class: str(r.report_class), Account_Category: str(r.report_category),
        Statement_Line: str(r.statement_line), Statement_Group: str(r.statement_group),
        Cash_Class: str(r.cash_class), Capex_Opex_Flag: str(r.capex_opex),
        Is_Bank: r.is_bank === true, Is_Active: r.is_active !== false,
        Schema_Version: GL_LINE_EXPORT_SCHEMA_VERSION,
      })),
    };
  }
  if (table === 'cost_centres') {
    const rows = (await sql`
      SELECT cc.id, cc.cc_type, cc.code, cc.name, p.code AS parent_code, cc.is_active,
             (SELECT string_agg(a.alias, '|' ORDER BY a.alias) FROM cost_centre_aliases a
               WHERE a.cost_centre_id = cc.id AND a.company_id = cc.company_id) AS aliases
      FROM cost_centres cc
      LEFT JOIN cost_centres p ON p.id = cc.parent_id AND p.company_id = cc.company_id
      WHERE cc.company_id = ${companyId}::UUID
      ORDER BY cc.cc_type, cc.code
    `) as DbRow[];
    return {
      columns: ['CC_ID', 'CC_Level', 'CC_Code', 'CC_Name', 'Parent_Code', 'Aliases', 'Is_Active', 'Schema_Version'],
      rows: rows.map((r) => ({
        CC_ID: String(r.id), CC_Level: str(r.cc_type), CC_Code: str(r.code), CC_Name: str(r.name),
        Parent_Code: str(r.parent_code), Aliases: str(r.aliases), Is_Active: r.is_active !== false,
        Schema_Version: GL_LINE_EXPORT_SCHEMA_VERSION,
      })),
    };
  }
  if (table === 'business_units') {
    const rows = (await sql`
      SELECT id, code, name, division, is_active FROM business_units
      WHERE company_id = ${companyId}::UUID ORDER BY code
    `) as DbRow[];
    return {
      columns: ['BU_ID', 'BU_Code', 'BU_Name', 'BU_Division', 'Is_Active', 'Schema_Version'],
      rows: rows.map((r) => ({
        BU_ID: String(r.id), BU_Code: str(r.code), BU_Name: str(r.name), BU_Division: str(r.division),
        Is_Active: r.is_active !== false, Schema_Version: GL_LINE_EXPORT_SCHEMA_VERSION,
      })),
    };
  }
  const rows = (await sql`
    SELECT s.id::TEXT AS id, COALESCE(s.company_name, s.name) AS name, 'Supplier' AS type, s.vat_number
    FROM suppliers s WHERE s.company_id = ${companyId}::UUID
    UNION ALL
    SELECT c.id::TEXT, c.name, 'Customer', c.vat_number
    FROM customers c WHERE c.company_id = ${companyId}::UUID
    ORDER BY 3, 2
  `) as DbRow[];
  return {
    columns: ['Counterparty_ID', 'Counterparty_Name', 'Counterparty_Type', 'VAT_Number', 'Schema_Version'],
    rows: rows.map((r) => ({
      Counterparty_ID: String(r.id), Counterparty_Name: str(r.name), Counterparty_Type: str(r.type),
      VAT_Number: str(r.vat_number), Schema_Version: GL_LINE_EXPORT_SCHEMA_VERSION,
    })),
  };
}
