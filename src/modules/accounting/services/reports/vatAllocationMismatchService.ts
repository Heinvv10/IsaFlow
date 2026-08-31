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
  rowCount: number;
  /** Total input/output tax sitting behind the listed rows. */
  totalVatAtRisk: number;
  rows: VatAllocationMismatch[];
}

/**
 * List allocated bank transactions whose VAT treatment is suspect.
 *
 * `from`/`to` are inclusive ISO dates; omit both to sweep everything.
 * `limit` caps the row list — the summary counts every matching row regardless.
 */
export async function findVatAllocationMismatches(
  companyId: string,
  opts: { from?: string; to?: string; limit?: number } = {},
): Promise<VatAllocationMismatchSummary> {
  const from = opts.from ?? null;
  const to = opts.to ?? null;
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000);

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
        (ARRAY_AGG(va.account_code ORDER BY GREATEST(jl.debit, jl.credit) DESC)
           FILTER (WHERE va.account_subtype IS DISTINCT FROM 'bank'
                     AND va.account_subtype NOT IN ('vat_input', 'vat_output')
                     AND jl.gl_account_id <> bt.bank_account_id))[1] AS account_code,
        (ARRAY_AGG(va.account_name ORDER BY GREATEST(jl.debit, jl.credit) DESC)
           FILTER (WHERE va.account_subtype IS DISTINCT FROM 'bank'
                     AND va.account_subtype NOT IN ('vat_input', 'vat_output')
                     AND jl.gl_account_id <> bt.bank_account_id))[1] AS account_name,
        (ARRAY_AGG(COALESCE(va.default_vat_code, '') ORDER BY GREATEST(jl.debit, jl.credit) DESC)
           FILTER (WHERE va.account_subtype IS DISTINCT FROM 'bank'
                     AND va.account_subtype NOT IN ('vat_input', 'vat_output')
                     AND jl.gl_account_id <> bt.bank_account_id))[1] AS account_default_vat_code
      FROM bank_transactions bt
      JOIN gl_journal_lines mjl
        ON mjl.id = bt.matched_journal_line_id AND mjl.company_id = bt.company_id
      JOIN gl_journal_entries je
        ON je.id = mjl.journal_entry_id AND je.company_id = bt.company_id
      JOIN gl_journal_lines jl
        ON jl.journal_entry_id = je.id AND jl.company_id = bt.company_id
      LEFT JOIN gl_accounts va ON va.id = jl.gl_account_id
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
      (c.displayed_vat_code <> c.journal_vat_code)                     AS displayed_differs
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

  return {
    rowCount: mapped.length,
    totalVatAtRisk: Math.round(
      mapped.reduce((sum, m) => sum + m.postedVatAmount, 0) * 100) / 100,
    rows: mapped,
  };
}
