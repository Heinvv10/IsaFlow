/**
 * VAT allocation mismatch report — read-only.
 *
 * Two questions a reviewer could not previously answer from any screen:
 *
 *  1. Where does the bank screen's VAT code disagree with the journal it
 *     allocated?  The screen read `suggested_vat_code`, which the rule
 *     auto-post path NULLs at allocation time, so a rule-posted row rendered
 *     "No VAT" over a journal that had debited VAT Input at 15%.
 *
 *  2. Where has input tax been claimed against an account that denies it?
 *     VAT Act s17(2)(a) denies input tax on entertainment. Migration 521 marks
 *     those accounts `default_vat_code = 'none'`; this finds the journals that
 *     were already posted before the guard existed.
 *
 * Nothing here writes. Correct a confirmed over-claim through
 * `reverseJournalEntry` and re-allocate — never by editing posted lines.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';

export type VatMismatchReason =
  /** Journal claimed input tax on an account whose default_vat_code is 'none'. */
  | 'input_vat_on_denied_account'
  /** The row's stored vat code differs from what the journal actually posted. */
  | 'displayed_differs_from_journal';

export interface VatAllocationMismatch {
  bankTransactionId: string;
  transactionDate: string;
  description: string | null;
  amount: number;
  /** What the bank screen's suggestion column says ('none' when cleared). */
  displayedVatCode: string;
  /** What the posted journal actually did. */
  journalVatCode: string;
  /** Input/output tax actually posted, in rands. */
  postedVatAmount: number;
  journalEntryId: string;
  journalEntryNumber: string | null;
  accountCode: string | null;
  accountName: string | null;
  accountDefaultVatCode: string | null;
  reasons: VatMismatchReason[];
}

export interface VatAllocationMismatchSummary {
  /** EVERY matching row, not just the page — the figure to scope work against. */
  rowCount: number;
  /** Total input/output tax behind every matching row, not just the page. */
  totalVatAtRisk: number;
  /** How many rows `rows` actually carries; less than rowCount when capped. */
  returnedRowCount: number;
  rows: VatAllocationMismatch[];
}

/**
 * List allocated bank transactions whose VAT treatment is suspect.
 *
 * `from`/`to` are inclusive ISO dates; omit both to sweep everything.
 * `limit` caps the row LIST; rowCount and totalVatAtRisk always describe every
 * matching row (window functions run before the LIMIT).
 */
export async function findVatAllocationMismatches(
  companyId: string,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<VatAllocationMismatchSummary> {
  const from = opts.from ?? null;
  const to = opts.to ?? null;
  // Number('abc') is NaN, and Math.min/max propagate it straight into LIMIT NaN
  // — a 500 where the caller deserves a 400. Fall back rather than throw here;
  // the route rejects a malformed value before it ever reaches this point.
  const requested = Number(opts.limit);
  const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 5000) : 500;

  const rows = (await sql`
    WITH allocated AS (
      SELECT
        bt.id                                   AS bank_transaction_id,
        bt.transaction_date,
        bt.description,
        bt.amount,
        COALESCE(NULLIF(bt.suggested_vat_code, ''), 'none') AS displayed_vat_code,
        je.id                                   AS journal_entry_id,
        je.entry_number,
        -- The tax line is what reaches VAT201, so its presence — not the
        -- contra line's vat_type — is what makes a journal "standard".
        SUM(CASE WHEN va.account_subtype IN ('vat_input', 'vat_output')
                 THEN ABS(COALESCE(jl.debit, 0)) + ABS(COALESCE(jl.credit, 0))
                 ELSE 0 END)                    AS posted_vat_amount,
        SUM(CASE WHEN va.account_subtype = 'vat_input'
                 THEN ABS(COALESCE(jl.debit, 0)) + ABS(COALESCE(jl.credit, 0))
                 ELSE 0 END)                    AS input_vat_amount,
        MAX(jl.vat_type) FILTER (
          WHERE jl.vat_type IN ('zero_rated', 'exempt'))  AS non_standard_vat_type,
        -- The expense/income account the money landed on: the contra line, i.e.
        -- neither the bank leg nor the tax leg.
        -- COALESCE, not a bare NOT IN: account_subtype is NULL on 49 of 284
        -- expense accounts, and NULL NOT IN (...) yields NULL, which the FILTER
        -- drops. Those rows returned a NULL account name and could never raise
        -- the denied-account flag — the report could not name what to fix.
        (ARRAY_AGG(va.account_code ORDER BY GREATEST(jl.debit, jl.credit) DESC)
           FILTER (WHERE COALESCE(va.account_subtype, '') <> 'bank'
                     AND COALESCE(va.account_subtype, '') NOT IN ('vat_input', 'vat_output')
                     AND jl.gl_account_id IS DISTINCT FROM bt.bank_account_id))[1] AS account_code,
        (ARRAY_AGG(va.account_name ORDER BY GREATEST(jl.debit, jl.credit) DESC)
           FILTER (WHERE COALESCE(va.account_subtype, '') <> 'bank'
                     AND COALESCE(va.account_subtype, '') NOT IN ('vat_input', 'vat_output')
                     AND jl.gl_account_id IS DISTINCT FROM bt.bank_account_id))[1] AS account_name,
        (ARRAY_AGG(COALESCE(va.default_vat_code, '') ORDER BY GREATEST(jl.debit, jl.credit) DESC)
           FILTER (WHERE COALESCE(va.account_subtype, '') <> 'bank'
                     AND COALESCE(va.account_subtype, '') NOT IN ('vat_input', 'vat_output')
                     AND jl.gl_account_id IS DISTINCT FROM bt.bank_account_id))[1] AS account_default_vat_code
      FROM bank_transactions bt
      JOIN gl_journal_lines mjl
        ON mjl.id = bt.matched_journal_line_id AND mjl.company_id = bt.company_id
      JOIN gl_journal_entries je
        ON je.id = mjl.journal_entry_id AND je.company_id = bt.company_id
      JOIN gl_journal_lines jl
        ON jl.journal_entry_id = je.id AND jl.company_id = bt.company_id
      LEFT JOIN gl_accounts va ON va.id = jl.gl_account_id AND va.company_id = bt.company_id
      WHERE bt.company_id = ${companyId}::UUID
        AND je.status = 'posted'
        AND (${from}::DATE IS NULL OR bt.transaction_date >= ${from}::DATE)
        AND (${to}::DATE   IS NULL OR bt.transaction_date <= ${to}::DATE)
      GROUP BY bt.id, bt.transaction_date, bt.description, bt.amount,
               bt.suggested_vat_code, bt.bank_account_id, je.id, je.entry_number
    ),
    classified AS (
      SELECT a.*,
        CASE WHEN a.posted_vat_amount > 0 THEN 'standard'
             ELSE COALESCE(a.non_standard_vat_type, 'none') END AS journal_vat_code
      FROM allocated a
    )
    SELECT c.*,
      (c.input_vat_amount > 0 AND c.account_default_vat_code = 'none') AS denied_account,
      (c.displayed_vat_code <> c.journal_vat_code)                     AS displayed_differs,
      -- Window functions run BEFORE the LIMIT, so these describe every matching
      -- row, not the page. A reviewer scoping a correction needs the real
      -- figure; a total capped by the page size is the wrong number to act on.
      COUNT(*) OVER ()                        AS total_row_count,
      SUM(c.posted_vat_amount) OVER ()        AS total_vat_at_risk
    FROM classified c
    WHERE (c.input_vat_amount > 0 AND c.account_default_vat_code = 'none')
       OR (c.displayed_vat_code <> c.journal_vat_code)
    ORDER BY c.posted_vat_amount DESC, c.transaction_date DESC
    LIMIT ${limit}
  `) as DbRow[];

  const mapped: VatAllocationMismatch[] = rows.map((r) => {
    const reasons: VatMismatchReason[] = [];
    if (r.denied_account) reasons.push('input_vat_on_denied_account');
    if (r.displayed_differs) reasons.push('displayed_differs_from_journal');
    return {
      bankTransactionId: String(r.bank_transaction_id),
      transactionDate: fmtDate(r.transaction_date),
      description: r.description ? String(r.description) : null,
      amount: Number(r.amount),
      displayedVatCode: String(r.displayed_vat_code),
      journalVatCode: String(r.journal_vat_code),
      postedVatAmount: Number(r.posted_vat_amount || 0),
      journalEntryId: String(r.journal_entry_id),
      journalEntryNumber: r.entry_number ? String(r.entry_number) : null,
      accountCode: r.account_code ? String(r.account_code) : null,
      accountName: r.account_name ? String(r.account_name) : null,
      accountDefaultVatCode: r.account_default_vat_code
        ? String(r.account_default_vat_code) : null,
      reasons,
    };
  });

  const first = rows[0];
  return {
    rowCount: first ? Number(first.total_row_count) : 0,
    totalVatAtRisk: first
      ? Math.round(Number(first.total_vat_at_risk || 0) * 100) / 100 : 0,
    returnedRowCount: mapped.length,
    rows: mapped,
  };
}
