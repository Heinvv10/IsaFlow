/**
 * A bank line allocated as a TRANSFER must not post a movement the ledger already holds (bankAllocationService).
 *
 * Two shapes of the same movement:
 *   1. the other bank's line, already allocated as the transfer back to this bank (a bank_transactions row that
 *      points at its transfer journal) within two days, whose journal no live line on THIS bank is linked to yet —
 *      the original guard, now with that consumption test (identical daily sweeps were refused);
 *   2. a TYPED Banking > Transfers journal (bank/bankTransferService: `reference` set; a statement allocation writes
 *      none), moving this amount in the SAME direction between the two banks (money into this bank: DR this bank /
 *      CR the other), dated within FIVE days (a Friday transfer clears on Monday or later), that no live line on THIS
 *      bank is linked to — by its transfer pointer or by an ordinary match of one of its lines. Without (2) a
 *      transfer typed on the Transfers page and then allocated from the statement posted twice (brk-nrfa M1). A
 *      statement-created journal is arm 1's business, not this arm's.
 * The remedy in both cases is to match the line to the existing journal.
 *
 * The other order — the statement first, then the same movement typed on the Transfers page — is caught by
 * `findTransferRecordedFromStatement`, below, which the Transfers page turns into a confirmation, not a refusal.
 *
 * Residual (stated, not closed): a typed post and a statement allocation of one movement IN FLIGHT TOGETHER both read
 * before either commits and both post. Closing it needs a lock shared by the bank-line allocation path, a single
 * writer whose lock order the cross-year census (agents/numrace/crossyear-census) shows is where new deadlocks come
 * from; the bank reconciliation shows the extra journal (no statement line matches it).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export async function assertNoDuplicateTransfer(
  companyId: string, bankAccountId: string, counterpartyAccountId: string, lineAmount: number, txDate: string,
): Promise<void> {
  const amount = Math.abs(lineAmount);
  // Money into this bank (a positive line) debits it; out of it credits it.
  const into = lineAmount > 0;
  const lines = (await sql`
    SELECT id FROM bank_transactions
    WHERE company_id = ${companyId}::UUID
      AND bank_account_id = ${counterpartyAccountId}::UUID
      AND counterparty_account_id = ${bankAccountId}::UUID
      AND transfer_journal_entry_id IS NOT NULL
      AND amount = ${-lineAmount}
      AND transaction_date BETWEEN (${txDate}::DATE - INTERVAL '2 days') AND (${txDate}::DATE + INTERVAL '2 days')
      -- Already paired: a live line on THIS bank is linked to that transfer journal, so this line is another
      -- movement (a daily sweep of identical transfers — brk-nrfa rounds 3-4, rev-nrfa round 4 LOW-2).
      AND NOT EXISTS (SELECT 1 FROM bank_transactions own WHERE own.company_id = bank_transactions.company_id
                        AND own.bank_account_id = ${bankAccountId}::UUID
                        AND own.status IN ('allocated', 'matched', 'reconciled')
                        AND (own.transfer_journal_entry_id = bank_transactions.transfer_journal_entry_id
                          OR own.matched_journal_line_id IN (SELECT ml.id FROM gl_journal_lines ml
                            WHERE ml.journal_entry_id = bank_transactions.transfer_journal_entry_id
                              AND ml.company_id = bank_transactions.company_id)))
    LIMIT 1
  `) as DbRow[];
  const journals = lines.length > 0 ? [] : (await sql`
    SELECT je.id FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.source = 'auto_bank_transfer' AND je.status = 'posted' AND je.reference IS NOT NULL
      AND je.reversed_at IS NULL AND je.reversal_of_id IS NULL
      AND je.entry_date BETWEEN (${txDate}::DATE - INTERVAL '5 days') AND (${txDate}::DATE + INTERVAL '5 days')
      AND EXISTS (SELECT 1 FROM gl_journal_lines jl WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id
                    AND jl.gl_account_id = ${bankAccountId}::UUID
                    AND (CASE WHEN ${into}::BOOLEAN THEN jl.debit ELSE jl.credit END) = ${amount})
      AND EXISTS (SELECT 1 FROM gl_journal_lines jl WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id
                    AND jl.gl_account_id = ${counterpartyAccountId}::UUID
                    AND (CASE WHEN ${into}::BOOLEAN THEN jl.credit ELSE jl.debit END) = ${amount})
      AND NOT EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.company_id = je.company_id
                        AND bt.bank_account_id = ${bankAccountId}::UUID
                        AND bt.status IN ('allocated', 'matched', 'reconciled')
                        AND (bt.transfer_journal_entry_id = je.id OR bt.matched_journal_line_id IN (
                          SELECT ml.id FROM gl_journal_lines ml WHERE ml.journal_entry_id = je.id
                            AND ml.company_id = je.company_id)))
    LIMIT 1
  `) as DbRow[];
  if (lines.length > 0 || journals.length > 0) {
    throw new Error(
      'A matching transfer already exists on the counterparty bank for this amount and date. ' +
      'Match the existing journal entry instead of posting a new one.',
    );
  }
}

/**
 * Banking > Transfers' twin of the guard: a live transfer journal the STATEMENT CREATED (a bank line allocated as a
 * transfer: bankAllocationService writes no `reference`; every Transfers-page journal carries 'Transfer: … -> …'),
 * still linked to a live, posted line of this amount on one of its bank legs (the side the line's sign says),
 * moving this amount from `fromAccountId` to `toAccountId` within five days of `date`. Its entry number, or null.
 * A typed transfer, matched to its statement line or not, never counts. Two real transfers of one amount are
 * legitimate, so the caller asks for a confirmation rather than refusing (brk-nrfa round 3 M2).
 */
export async function findTransferRecordedFromStatement(
  companyId: string, fromAccountId: string, toAccountId: string, amount: number, date: string,
): Promise<string | null> {
  const rows = (await sql`
    SELECT je.entry_number FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.source = 'auto_bank_transfer' AND je.status = 'posted' AND je.reference IS NULL
      AND je.reversed_at IS NULL AND je.reversal_of_id IS NULL
      AND je.entry_date BETWEEN (${date}::DATE - INTERVAL '5 days') AND (${date}::DATE + INTERVAL '5 days')
      AND EXISTS (SELECT 1 FROM gl_journal_lines jl WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id
                    AND jl.gl_account_id = ${toAccountId}::UUID AND jl.debit = ${amount})
      AND EXISTS (SELECT 1 FROM gl_journal_lines jl WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id
                    AND jl.gl_account_id = ${fromAccountId}::UUID AND jl.credit = ${amount})
      AND EXISTS (SELECT 1 FROM bank_transactions bt
                    JOIN gl_journal_lines bl ON bl.journal_entry_id = je.id AND bl.company_id = je.company_id
                      AND bl.gl_account_id = bt.bank_account_id
                      AND (CASE WHEN bt.amount > 0 THEN bl.debit ELSE bl.credit END) = ABS(bt.amount)
                    WHERE bt.company_id = je.company_id
                    AND bt.transfer_journal_entry_id = je.id AND ABS(bt.amount) = ${amount}
                    AND bt.status IN ('allocated', 'matched', 'reconciled') AND bt.feed_state = 'posted')
    ORDER BY je.entry_date, je.entry_number
    LIMIT 1
  `) as DbRow[];
  return rows.length > 0 ? String(rows[0]!.entry_number) : null;
}
