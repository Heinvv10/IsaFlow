/**
 * Auto-match — pair imported bank rows against posted bank-account journal lines.
 *
 * Split out of `bankReconciliationService` (which re-exports it) to keep that
 * file under the 300-line limit. The run applies every high-confidence pair
 * through `matchTransaction` and must survive the two ways a single row can
 * fail: a peer that claimed the line first (a race, counted and skipped) and a
 * table that is locked by DDL (infrastructure, counted separately).
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { runAutoMatch } from '../../utils/autoMatch';
import {
  matchTransaction, BankTransactionAllocatedError, BankMatchTargetError,
} from './bankTransactionQueryService';
import { BankTransactionLockTimeoutError } from './bankTxLock';
import { BankMatchUnavailableError } from './bankTxStatusMutations';
import type { AutoMatchResult } from '../../types/bank.types';
import type { DbRow } from '@/types/db';

export async function autoMatchTransactions(
  companyId: string, bankAccountId: string, reconciliationId?: string
): Promise<AutoMatchResult> {
  try {
    const bankTxRows = (await sql`
      SELECT id, amount, transaction_date, reference, description
      FROM bank_transactions
      WHERE bank_account_id = ${bankAccountId}::UUID
        AND company_id = ${companyId}::UUID
        AND status = 'imported'
      ORDER BY transaction_date`) as DbRow[];
    if (bankTxRows.length === 0) return { matched: 0, unmatched: 0, candidates: [] };
    const glRows = (await sql`
      SELECT jl.id, jl.debit, jl.credit, jl.description,
        je.entry_date, je.entry_number, je.source_document_id
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.gl_account_id = ${bankAccountId}::UUID
        AND jl.company_id = ${companyId}::UUID
        AND je.status = 'posted' AND je.company_id = ${companyId}::UUID
        -- company_id on the subquery: unscoped it read every tenant's rows.
        AND jl.id NOT IN (
          SELECT matched_journal_line_id FROM bank_transactions
          WHERE matched_journal_line_id IS NOT NULL
            AND company_id = ${companyId}::UUID)
      ORDER BY je.entry_date`) as DbRow[];
    const bankTxs = bankTxRows.map((r: DbRow) => ({
      id: String(r.id), amount: Number(r.amount), transactionDate: String(r.transaction_date),
      reference: r.reference ? String(r.reference) : undefined,
      description: r.description ? String(r.description) : undefined,
    }));
    const glLines = glRows.map((r: DbRow) => ({
      id: String(r.id), debit: Number(r.debit), credit: Number(r.credit),
      description: r.description ? String(r.description) : undefined,
      entryDate: String(r.entry_date),
      entryNumber: r.entry_number ? String(r.entry_number) : undefined,
      sourceDocumentId: r.source_document_id ? String(r.source_document_id) : undefined,
    }));
    const result = runAutoMatch(bankTxs, glLines);
    let matchedCount = 0;
    let skippedRaced = 0;
    let skippedUnavailable = 0;
    // Locked in transaction-id order: matchTransaction takes a row lock that is
    // held to the end of the request, so a run walking its rows in a different
    // order from a concurrent allocation deadlocks on the pair (40P01).
    const ordered = [...result.matches].sort((a, b) =>
      a.bankTransactionId < b.bankTransactionId ? -1 : a.bankTransactionId > b.bankTransactionId ? 1 : 0);
    for (const match of ordered) {
      if (match.confidence >= 0.9) {
        try {
          await matchTransaction(companyId, match.bankTransactionId, match.journalLineId, reconciliationId);
          matchedCount++;
        } catch (matchErr) {
          // The candidate query read these rows in bulk; one of them has been
          // allocated since. Skip it and keep going — letting it escape would
          // abort the loop, and because withAuth COMMITs on any handler that
          // returns (the route catches and 400s), the matches already applied
          // would persist while the remaining ones were silently dropped.
          // Anything else is a real failure and must still reach the caller.
          // BankMatchTargetError/LINE_CLAIMED is the same race seen from the
          // other side: the candidate query above excludes already-claimed
          // lines, so it can only fire when a peer bound this line between that
          // read and this write — including via `uq_bank_tx_matched_line`,
          // which is what catches the pair that both passed the check.
          // BankTransactionLockTimeoutError is the same race seen slowly: the
          // peer is holding the bank row past the 5s lock_timeout. Skipping it
          // is the same decision as the two above — the run reports it and a
          // re-run picks the row up — and letting it escape is the one outcome
          // that loses the matches already applied.
          const raced = matchErr instanceof BankTransactionAllocatedError
            || matchErr instanceof BankTransactionLockTimeoutError
            || (matchErr instanceof BankMatchTargetError && matchErr.code === 'LINE_CLAIMED');
          // A locked TABLE is not a race and must never be reported as one:
          // `skippedRaced` reaches the user as "allocated by another request",
          // a factual claim about the row. The row is skipped the same way —
          // the run must not lose the matches already applied — but it is
          // counted apart so the caller can tell a contended line from a
          // window in which nothing could be matched at all.
          if (!raced && !(matchErr instanceof BankMatchUnavailableError)) throw matchErr;
          if (raced) skippedRaced++; else skippedUnavailable++;
        }
      }
    }
    const lowConfidence = result.matches.filter(m => m.confidence < 0.9);
    log.info('Auto-match completed', {
      bankAccountId, autoMatched: matchedCount, skippedRaced, skippedUnavailable,
      candidates: lowConfidence.length, unmatched: result.unmatched.length,
    }, 'accounting');
    return {
      matched: matchedCount, unmatched: result.unmatched.length,
      candidates: lowConfidence, skippedRaced, skippedUnavailable,
    };
  } catch (err) {
    log.error('Failed to auto-match transactions', { error: err }, 'accounting');
    throw err;
  }
}
