/**
 * Integrity checks over the bank feed and what it posted.
 *
 * All three found material problems on production the first time they ran:
 * 2,253 journals dated away from their own bank transaction on Brightsphere,
 * 961 duplicated statement references, and 1,605 transactions that look done
 * and are not in the general ledger.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { num, r2, str, type IntegrityCheckContext, type IntegrityCheckResult, type IntegritySampleRow } from './types';

/** Days after which a suggestion stops being work in progress and becomes a gap. */
const STALE_DAYS = 30;

function sample(rows: DbRow[]): IntegritySampleRow[] {
  return rows.map((r) => ({
    id: str(r.id),
    label: str(r.label),
    amount: r.amount === null || r.amount === undefined ? undefined : r2(num(r.amount)),
    detail: r.detail === null || r.detail === undefined ? undefined : str(r.detail),
  }));
}

/**
 * Journals whose date does not match the bank transaction that produced them.
 *
 * A one-day drift is invisible day to day and decides which VAT period and
 * which financial year a transaction lands in. Brightsphere has 2,253 of them,
 * drifting from one day early to twenty-eight days late.
 */
export async function journalDateDiffersFromBankDate(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  const where = sql`
    FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id AND jl.company_id = bt.company_id
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = bt.company_id
    WHERE bt.company_id = ${ctx.companyId}::UUID
      AND bt.transaction_date <= ${ctx.asAt}::DATE
      AND je.entry_date <> bt.transaction_date
  `;
  const totals = (await sql`
    SELECT COUNT(*)::INT AS count, COALESCE(SUM(ABS(bt.amount)), 0) AS amount ${where}
  `) as DbRow[];
  const rows = (await sql`
    SELECT bt.id::TEXT AS id,
           COALESCE(je.entry_number, je.id::TEXT) AS label,
           bt.amount AS amount,
           'bank ' || bt.transaction_date::TEXT || ' vs journal ' || je.entry_date::TEXT
             || ' (' || (je.entry_date - bt.transaction_date)::TEXT || ' days)' AS detail
    ${where}
    ORDER BY ABS(je.entry_date - bt.transaction_date) DESC, bt.transaction_date
    LIMIT ${ctx.limit}
  `) as DbRow[];

  return {
    id: 'journal_date_differs_from_bank_date',
    label: 'Journals dated away from their source bank transaction',
    severity: 'high',
    count: num(totals[0]?.count),
    amount: r2(num(totals[0]?.amount)),
    sample: sample(rows),
    finding:
      'The journal carries a different date from the bank line that produced it. A single day decides which VAT period and which financial year the transaction falls in, and neither report will disagree with the other about it.',
  };
}

/**
 * Statement references used by more than one transaction.
 *
 * The reference is what an agent hands to `allocate_bank_transaction` to name a
 * line. 961 references on Brightsphere name more than one row, so the reference
 * is not a key and resolving by it is a coin toss.
 */
export async function duplicateBankReferences(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  const dupes = sql`
    SELECT COALESCE(NULLIF(bt.reference, ''), bt.bank_reference) AS ref,
           COUNT(*)::INT AS n,
           SUM(ABS(bt.amount)) AS amount,
           -- min(uuid) does not exist in Postgres; take the first id by sort order.
           (ARRAY_AGG(bt.id ORDER BY bt.id))[1]::TEXT AS id
    FROM bank_transactions bt
    WHERE bt.company_id = ${ctx.companyId}::UUID
      AND bt.transaction_date <= ${ctx.asAt}::DATE
      AND COALESCE(NULLIF(bt.reference, ''), bt.bank_reference) IS NOT NULL
    GROUP BY 1
    HAVING COUNT(*) > 1
  `;
  const totals = (await sql`
    SELECT COUNT(*)::INT AS count, COALESCE(SUM(d.amount), 0) AS amount FROM (${dupes}) d
  `) as DbRow[];
  const rows = (await sql`
    SELECT d.id, d.ref AS label, d.amount, d.n::TEXT || ' transactions share this reference' AS detail
    FROM (${dupes}) d ORDER BY d.n DESC, d.ref LIMIT ${ctx.limit}
  `) as DbRow[];

  return {
    id: 'duplicate_bank_references',
    label: 'Statement references shared by more than one transaction',
    severity: 'medium',
    count: num(totals[0]?.count),
    amount: r2(num(totals[0]?.amount)),
    sample: sample(rows),
    finding:
      'The reference is what names a bank line to an agent allocating it. Where more than one row carries the same reference, resolving by reference picks one of them arbitrarily. Count is duplicated REFERENCES, not rows.',
  };
}

/**
 * Transactions carrying a suggestion, still unallocated, and old.
 *
 * These look finished in the UI and are not in the general ledger. 1,605 on
 * Brightsphere at R19,990,775.58, none of which has reached a single report.
 */
export async function staleSuggestedTransactions(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  const where = sql`
    FROM bank_transactions bt
    WHERE bt.company_id = ${ctx.companyId}::UUID
      AND bt.matched_journal_line_id IS NULL
      AND bt.status <> 'excluded'
      AND (bt.suggested_gl_account_id IS NOT NULL OR bt.allocation_type IS NOT NULL
           OR bt.suggested_supplier_id IS NOT NULL OR bt.suggested_client_id IS NOT NULL)
      AND bt.transaction_date <= ${ctx.asAt}::DATE - ${STALE_DAYS}::INT
  `;
  const totals = (await sql`
    SELECT COUNT(*)::INT AS count, COALESCE(SUM(ABS(bt.amount)), 0) AS amount ${where}
  `) as DbRow[];
  const rows = (await sql`
    SELECT bt.id::TEXT AS id,
           COALESCE(NULLIF(bt.reference, ''), bt.bank_reference, LEFT(COALESCE(bt.description, ''), 60)) AS label,
           bt.amount AS amount,
           'suggested, unposted since ' || bt.transaction_date::TEXT AS detail
    ${where}
    ORDER BY bt.transaction_date LIMIT ${ctx.limit}
  `) as DbRow[];

  return {
    id: 'stale_suggested_transactions',
    label: 'Suggested but unposted bank transactions older than 30 days',
    severity: 'high',
    count: num(totals[0]?.count),
    amount: r2(num(totals[0]?.amount)),
    sample: sample(rows),
    finding:
      'A suggested transaction is categorised and looks handled, but no journal exists. None of this money is in the trial balance, the VAT201 or any bank reconciliation.',
  };
}
