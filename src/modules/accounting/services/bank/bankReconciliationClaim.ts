/**
 * Which bank lines a reconciliation session claims, and which of them already
 * count as matched — ONE definition, read by start (claim), the session counts
 * (getReconciliations / getReconciliationById), completion and the MCP dry run.
 *
 * ── WHY AN ALLOCATED LINE IS ITS OWN MATCH ─────────────────────────────────
 *
 * Allocating a bank line posts its journal and stores that journal's BANK LEG
 * on the line (`matched_journal_line_id`, status `allocated`). The pairing a
 * reconciliation exists to establish — this statement line is that ledger line
 * — is therefore already made, by construction, with certainty. Start used to
 * claim only `status = 'imported'` lines, and auto-match reads only `imported`
 * lines, so on books allocated through the feed a session claimed nothing but
 * the leftovers (VF1: 256 unallocated lines; SBSA, every line allocated: 0),
 * matched nothing, and could never complete — while the ledger agreed to the
 * statement to the cent.
 *
 * A self-match is accepted only when its line is a real, current posting that
 * sits inside the GL balance the session compares against: a line of THIS
 * bank account, of THIS company, on a POSTED journal that has not been
 * reversed, dated on or before the statement date. Anything else stays
 * unmatched and visible — never counted as proof.
 *
 * ── BOUNDS ─────────────────────────────────────────────────────────────────
 *
 * Claimed: this company, this bank account, `feed_state = 'posted'`,
 * `transaction_date <= statement_date`, status `imported` or a self-matchable
 * `allocated`. Never `reconciled` (done) or `excluded` (out of scope). A line
 * whose stamp names an IN-PROGRESS session belongs to that session and is not
 * taken; a stamp left by a COMPLETED session (start stamps every candidate,
 * completion reconciles only the matched ones) is stale and is re-claimed —
 * before this, those leftovers were stranded for every later session.
 */

import { sql, type TxSql } from '@/lib/neon';
import type { DbRow } from '@/types/db';

type Fragment = ReturnType<typeof sql>;

/**
 * `bt`'s own journal line is a current posting on its bank account, inside the
 * GL balance as at `asAtDate`. Reads `bt.*`; the caller aliases the row `bt`.
 * `asAtDate` is a fragment so the counts can correlate on `br.statement_date`.
 */
export function ownJournalLineCounts(companyId: string, asAtDate: Fragment): Fragment {
  return sql`EXISTS (
    SELECT 1
    FROM gl_journal_lines own_jl
    JOIN gl_journal_entries own_je ON own_je.id = own_jl.journal_entry_id
    WHERE own_jl.id = bt.matched_journal_line_id
      AND own_jl.company_id = ${companyId}::UUID
      AND own_je.company_id = ${companyId}::UUID
      AND own_jl.gl_account_id = bt.bank_account_id
      AND own_je.status = 'posted'
      AND own_je.reversed_at IS NULL
      AND own_je.entry_date <= ${asAtDate})`;
}

/**
 * A session line that counts as matched: matched by a person or auto-match,
 * or allocated with a self-matchable journal line.
 */
export function countsAsMatched(companyId: string, asAtDate: Fragment): Fragment {
  return sql`(bt.status = 'matched' OR (
    bt.status = 'allocated' AND bt.matched_journal_line_id IS NOT NULL
    AND ${ownJournalLineCounts(companyId, asAtDate)}))`;
}

/** A session line still waiting: unallocated, or allocated with a line that does not count. */
export function countsAsUnmatched(companyId: string, asAtDate: Fragment): Fragment {
  return sql`(bt.status = 'imported' OR (
    bt.status = 'allocated' AND NOT (bt.matched_journal_line_id IS NOT NULL
    AND ${ownJournalLineCounts(companyId, asAtDate)})))`;
}

/** Free to claim: no stamp, or a stamp left behind by a session that is no longer in progress. */
function claimable(companyId: string): Fragment {
  return sql`(bt.reconciliation_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM bank_reconciliations held
    WHERE held.id = bt.reconciliation_id
      AND held.company_id = ${companyId}::UUID
      AND held.status = 'in_progress'))`;
}

export interface ReconciliationClaim {
  /** Unallocated (`imported`) lines claimed; auto-match works on these. */
  claimedUnallocated: number;
  /** Allocated lines claimed AND matched to their own journal line (confidence 1.0). */
  selfMatched: number;
}

/**
 * Stamp the session on every line it covers. Runs inside start's transaction,
 * after the header INSERT. Idempotent: a second call claims nothing new, since
 * every line it would take already carries this (in-progress) session's id.
 */
export async function claimTransactionsForReconciliation(
  tx: TxSql, companyId: string, reconciliationId: string,
  bankAccountId: string, statementDate: string,
): Promise<ReconciliationClaim> {
  const unallocated = (await tx`
    UPDATE bank_transactions bt
    SET reconciliation_id = ${reconciliationId}::UUID, updated_at = NOW()
    WHERE bt.company_id = ${companyId}::UUID
      AND bt.bank_account_id = ${bankAccountId}::UUID
      AND bt.feed_state = 'posted'
      AND bt.status = 'imported'
      AND bt.transaction_date <= ${statementDate}::DATE
      AND ${claimable(companyId)}
    RETURNING bt.id`) as DbRow[];
  const selfMatched = (await tx`
    UPDATE bank_transactions bt
    SET reconciliation_id = ${reconciliationId}::UUID, updated_at = NOW()
    WHERE bt.company_id = ${companyId}::UUID
      AND bt.bank_account_id = ${bankAccountId}::UUID
      AND bt.feed_state = 'posted'
      AND bt.status = 'allocated'
      AND bt.matched_journal_line_id IS NOT NULL
      AND bt.transaction_date <= ${statementDate}::DATE
      AND ${claimable(companyId)}
      AND ${ownJournalLineCounts(companyId, sql`${statementDate}::DATE`)}
    RETURNING bt.id`) as DbRow[];
  return { claimedUnallocated: unallocated.length, selfMatched: selfMatched.length };
}

/** What `claimTransactionsForReconciliation` WOULD claim. Reads only — the dry run. */
export async function previewReconciliationClaim(
  companyId: string, bankAccountId: string, statementDate: string,
): Promise<ReconciliationClaim> {
  const rows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE bt.status = 'imported') AS unallocated,
      COUNT(*) FILTER (WHERE bt.status = 'allocated' AND bt.matched_journal_line_id IS NOT NULL
        AND ${ownJournalLineCounts(companyId, sql`${statementDate}::DATE`)}) AS self_matched
    FROM bank_transactions bt
    WHERE bt.company_id = ${companyId}::UUID
      AND bt.bank_account_id = ${bankAccountId}::UUID
      AND bt.feed_state = 'posted'
      AND bt.transaction_date <= ${statementDate}::DATE
      AND ${claimable(companyId)}`) as DbRow[];
  return {
    claimedUnallocated: Number(rows[0]?.unallocated ?? 0),
    selfMatched: Number(rows[0]?.self_matched ?? 0),
  };
}
