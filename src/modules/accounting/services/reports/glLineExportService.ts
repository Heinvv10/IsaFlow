/**
 * Flat GL-line export — v1 of the ledger brief's §4 field contract, shaped per
 * its §9 export contract (one row per journal line, fixed column order, ISO
 * dates, decimals with a point and no separators, blank means blank). The row
 * contract is glLineExportRows.ts; the dimension master files are
 * glLineExportTables.ts; this file holds the line queries.
 *
 * GRAIN. One row per `gl_journal_lines` row. A transaction (journal entry) with
 * four lines is four rows sharing a Txn_ID; debits positive, credits negative,
 * so every posted Txn_ID sums to zero and so does the file (the control total).
 *
 * COUNTERPARTY AND DOCUMENT. The document tables hold the journal id
 * (`gl_journal_entry_id`), not the other way round, so each page resolves its
 * entries against supplier invoices, customer invoices, credit notes, supplier
 * payments, customer receipts and the bank line a journal line was matched to —
 * restricted to the entries on the page so a page never scans the whole
 * document history. A manual journal has no counterparty, and says so (blank).
 * When several documents name one journal, Document_No and the counterparty are
 * taken from the first by a fixed precedence — supplier invoice, customer
 * invoice, credit note, supplier payment, customer receipt — and within a table
 * the lowest document number, then id. Linked_Document_Count says how many
 * there were, so a row showing one of several says so.
 *
 * TENANCY. Every table is read with this company's id, joins included: the
 * dimension and account columns carry no tenant-pair FK, so a legacy line can
 * name another company's row, and an unscoped join would print its name here.
 * Such a line still exports — the joins are LEFT — with the foreign fields blank.
 *
 * WHAT IS NOT HERE (v2 per the plan): loan Movement_Type, Revenue_State,
 * retention, Phase/Zone/PON, payroll Pay_Component, stock movements, card
 * holder, and per-row VAT pairing.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { CASH_SUBTYPES } from '@/modules/accounting/services/gl/accountSubtypes';
import { DEFAULT_FY_START_MONTH, resolveFiscalYearStartMonth } from '@/modules/accounting/services/gl/fiscalYearBasis';
import { GL_LINE_EXPORT_SCHEMA_VERSION, isoDate, toNum, type ExportEntity } from './glLineExportRows';

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

/**
 * The entity every row carries: the company's name and its fiscal basis.
 * READ PATH: a company with no usable financial_year_start falls back to March
 * (the column default), visibly here, as the trial balance does — an export
 * refusing to run over a missing setting helps nobody.
 */
export async function getExportEntity(companyId: string): Promise<ExportEntity> {
  const rows = (await sql`
    SELECT name, financial_year_start FROM companies WHERE id = ${companyId}::UUID LIMIT 1
  `) as DbRow[];
  return {
    name: String(rows[0]?.name ?? ''),
    fyStartMonth: resolveFiscalYearStartMonth(
      rows[0]?.financial_year_start, companyId, { fallback: DEFAULT_FY_START_MONTH },
    ),
  };
}

export function clampPage(limit: number): number {
  if (!Number.isFinite(limit)) return GL_LINE_EXPORT_MAX_PAGE;
  return Math.max(1, Math.min(GL_LINE_EXPORT_MAX_PAGE, Math.floor(limit)));
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
    -- Per table: the first document by number then id, and how many there are.
    -- "By number" is natural: the prefix, then the trailing digits as a number
    -- (INV-9 before INV-10), then the whole text.
    si AS (
      SELECT DISTINCT ON (si.gl_journal_entry_id) si.gl_journal_entry_id AS entry_id,
             si.supplier_id, si.invoice_number, COUNT(*) OVER (PARTITION BY si.gl_journal_entry_id) AS n
      FROM supplier_invoices si
      WHERE si.company_id = ${companyId}::UUID AND si.gl_journal_entry_id IN (SELECT entry_id FROM entries)
      ORDER BY si.gl_journal_entry_id, regexp_replace(si.invoice_number, '[0-9]+$', ''),
               substring(si.invoice_number FROM '[0-9]+$')::NUMERIC, si.invoice_number, si.id
    ),
    ci AS (
      SELECT DISTINCT ON (ci.gl_journal_entry_id) ci.gl_journal_entry_id AS entry_id,
             COALESCE(ci.client_id, ci.customer_id) AS customer_id, ci.invoice_number,
             COUNT(*) OVER (PARTITION BY ci.gl_journal_entry_id) AS n
      FROM customer_invoices ci
      WHERE ci.company_id = ${companyId}::UUID AND ci.gl_journal_entry_id IN (SELECT entry_id FROM entries)
      ORDER BY ci.gl_journal_entry_id, regexp_replace(ci.invoice_number, '[0-9]+$', ''),
               substring(ci.invoice_number FROM '[0-9]+$')::NUMERIC, ci.invoice_number, ci.id
    ),
    cn AS (
      SELECT DISTINCT ON (cn.gl_journal_entry_id) cn.gl_journal_entry_id AS entry_id,
             cn.type AS cn_type, cn.supplier_id, cn.client_id AS customer_id, cn.credit_note_number,
             COUNT(*) OVER (PARTITION BY cn.gl_journal_entry_id) AS n
      FROM credit_notes cn
      WHERE cn.company_id = ${companyId}::UUID AND cn.gl_journal_entry_id IN (SELECT entry_id FROM entries)
      ORDER BY cn.gl_journal_entry_id, regexp_replace(cn.credit_note_number, '[0-9]+$', ''),
               substring(cn.credit_note_number FROM '[0-9]+$')::NUMERIC, cn.credit_note_number, cn.id
    ),
    sp AS (
      SELECT DISTINCT ON (sp.gl_journal_entry_id) sp.gl_journal_entry_id AS entry_id,
             sp.supplier_id, sp.payment_number, COUNT(*) OVER (PARTITION BY sp.gl_journal_entry_id) AS n
      FROM supplier_payments sp
      WHERE sp.company_id = ${companyId}::UUID AND sp.gl_journal_entry_id IN (SELECT entry_id FROM entries)
      ORDER BY sp.gl_journal_entry_id, regexp_replace(sp.payment_number, '[0-9]+$', ''),
               substring(sp.payment_number FROM '[0-9]+$')::NUMERIC, sp.payment_number, sp.id
    ),
    cp AS (
      SELECT DISTINCT ON (cp.gl_journal_entry_id) cp.gl_journal_entry_id AS entry_id,
             cp.client_id AS customer_id, cp.payment_number, COUNT(*) OVER (PARTITION BY cp.gl_journal_entry_id) AS n
      FROM customer_payments cp
      WHERE cp.company_id = ${companyId}::UUID AND cp.gl_journal_entry_id IN (SELECT entry_id FROM entries)
      ORDER BY cp.gl_journal_entry_id, regexp_replace(cp.payment_number, '[0-9]+$', ''),
               substring(cp.payment_number FROM '[0-9]+$')::NUMERIC, cp.payment_number, cp.id
    ),
    bt AS (
      SELECT DISTINCT ON (ml.journal_entry_id) ml.journal_entry_id AS entry_id,
             bt.reference, bt.allocated_entity_name
      FROM bank_transactions bt
      JOIN gl_journal_lines ml ON ml.id = bt.matched_journal_line_id AND ml.company_id = ${companyId}::UUID
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
      LEFT JOIN gl_journal_entries rv ON rv.id = je.reversal_of_id AND rv.company_id = ${companyId}::UUID
      -- By date, not fiscal_period_id: older rows have no period id (501 did
      -- no backfill), and 502 forbids overlapping periods, so this is unique.
      LEFT JOIN fiscal_periods fp ON fp.company_id = ${companyId}::UUID
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
           COALESCE(si.n, 0) + COALESCE(ci.n, 0) + COALESCE(cn.n, 0)
             + COALESCE(sp.n, 0) + COALESCE(cp.n, 0) AS linked_document_count,
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
    LEFT JOIN gl_accounts ga ON ga.id = p.gl_account_id AND ga.company_id = ${companyId}::UUID
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
