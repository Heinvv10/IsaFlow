/**
 * A bank line allocated as a TRANSFER must not post a movement the ledger already holds (bankAllocationService).
 *
 * Two shapes of the same movement:
 *   1. the other bank's line, already allocated as the transfer back to this bank (a bank_transactions row that
 *      points at its transfer journal) — the original guard;
 *   2. a Banking > Transfers journal (bank/bankTransferService), which has no bank line behind it: a live
 *      auto_bank_transfer journal with a line on each of the two banks for this amount, dated within two days, that
 *      no live line on THIS bank is linked to. Without (2) a transfer typed on the Transfers page and then allocated
 *      from the statement posted twice (brk-nrfa M1, 2026-10-08).
 * The remedy in both cases is to match the line to the existing journal.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export async function assertNoDuplicateTransfer(
  companyId: string, bankAccountId: string, counterpartyAccountId: string, lineAmount: number, txDate: string,
): Promise<void> {
  const amount = Math.abs(lineAmount);
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
                    AND jl.gl_account_id = ${bankAccountId}::UUID AND GREATEST(jl.debit, jl.credit) = ${amount})
      AND EXISTS (SELECT 1 FROM gl_journal_lines jl WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id
                    AND jl.gl_account_id = ${counterpartyAccountId}::UUID AND GREATEST(jl.debit, jl.credit) = ${amount})
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
