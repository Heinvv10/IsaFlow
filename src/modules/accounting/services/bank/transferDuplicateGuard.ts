/**
 * A bank line allocated as a TRANSFER must not post a movement the ledger already holds (bankAllocationService).
 *
 * Two shapes of the same movement:
 *   1. the other bank's line, already allocated as the transfer back to this bank (a bank_transactions row that
 *      points at its transfer journal) — the original guard;
 *   2. a Banking > Transfers journal (bank/bankTransferService), which has no bank line behind it: a live
 *      auto_bank_transfer journal moving this amount in the SAME direction between the two banks (money into this
 *      bank: DR this bank / CR the other), dated within two days, that no live line on THIS bank is linked to.
 *      Without (2) a transfer typed on the Transfers page and then allocated from the statement posted twice
 *      (brk-nrfa M1, 2026-10-08); without the direction a typed B->A refused a genuine A->B (rev-nrfa LOW-2).
 * The remedy in both cases is to match the line to the existing journal.
 *
 * The other order — the statement first, then the same movement typed on the Transfers page — is refused by
 * `findTransferRecordedFromStatement`, below (rev-nrfa LOW-1).
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
    LIMIT 1
  `) as DbRow[];
  const journals = lines.length > 0 ? [] : (await sql`
    SELECT je.id FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.source = 'auto_bank_transfer' AND je.status = 'posted'
      AND je.reversed_at IS NULL AND je.reversal_of_id IS NULL
      AND je.entry_date BETWEEN (${txDate}::DATE - INTERVAL '2 days') AND (${txDate}::DATE + INTERVAL '2 days')
      AND EXISTS (SELECT 1 FROM gl_journal_lines jl WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id
                    AND jl.gl_account_id = ${bankAccountId}::UUID
                    AND (CASE WHEN ${into}::BOOLEAN THEN jl.debit ELSE jl.credit END) = ${amount})
      AND EXISTS (SELECT 1 FROM gl_journal_lines jl WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id
                    AND jl.gl_account_id = ${counterpartyAccountId}::UUID
                    AND (CASE WHEN ${into}::BOOLEAN THEN jl.credit ELSE jl.debit END) = ${amount})
      AND NOT EXISTS (SELECT 1 FROM bank_transactions bt WHERE bt.company_id = je.company_id
                        AND bt.bank_account_id = ${bankAccountId}::UUID AND bt.transfer_journal_entry_id = je.id
                        AND bt.status IN ('allocated', 'matched', 'reconciled'))
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
 * moving this amount from `fromAccountId` to `toAccountId` within two days of `date`. Its entry number, or null. A typed transfer — matched to its statement line or not —
 * never refuses another typed one: two real transfers of one amount are legitimate (rev-nrfa LOW-1, round 3).
 */
export async function findTransferRecordedFromStatement(
  companyId: string, fromAccountId: string, toAccountId: string, amount: number, date: string,
): Promise<string | null> {
  const rows = (await sql`
    SELECT je.entry_number FROM gl_journal_entries je
    WHERE je.company_id = ${companyId}::UUID
      AND je.source = 'auto_bank_transfer' AND je.status = 'posted' AND je.reference IS NULL
      AND je.reversed_at IS NULL AND je.reversal_of_id IS NULL
      AND je.entry_date BETWEEN (${date}::DATE - INTERVAL '2 days') AND (${date}::DATE + INTERVAL '2 days')
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
