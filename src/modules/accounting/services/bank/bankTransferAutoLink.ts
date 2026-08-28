/**
 * Transfer auto-link: when one leg of an inter-account transfer is allocated,
 * settle the opposite bank's statement line against the same journal.
 *
 * Extracted from `bankAllocationService.allocateTransaction`, which is over the
 * 300-line limit; behaviour is unchanged.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

type Row = DbRow;

export interface TransferAutoLinkInput {
  companyId: string;
  /** The transaction being allocated — the leg the user is working on. */
  bankTxId: string;
  /** GL account of the bank this transaction belongs to. */
  bankAccountId: string;
  /** GL account of the bank on the other side of the transfer. */
  counterpartyAccountId: string;
  /** Journal posted for this allocation; the counterparty leg joins the same one. */
  journalEntryId: string;
  /** Signed amount of the transaction being allocated. */
  amount: number;
  /** Its date, already rendered with fmtDate. */
  txDate: string;
  allocatedEntityName: string | null;
}

/**
 * Find the opposite bank's still-`imported` line for this transfer and settle
 * it against the same journal.
 *
 * Best-effort by design: no counterparty row is a perfectly normal outcome (the
 * other statement may not be imported yet), and the allocation that just posted
 * is correct either way — so a failure here is logged and swallowed.
 *
 * That swallow is only safe inside a SAVEPOINT. EVERY Postgres error aborts the
 * transaction it happens in, not just deadlocks: without the savepoint, one
 * failed statement here left the request in the aborted state and every
 * statement after it raised 25P02, so the caller returned a journal id for a
 * journal that could never commit. Rolling back to the savepoint discards the
 * failed link and leaves the outer transaction — and the posted journal —
 * intact. (An error-code whitelist was the previous attempt at this, and it
 * could only ever cover the codes someone thought to list.)
 */
export async function autoLinkCounterpartyTransfer(input: TransferAutoLinkInput): Promise<void> {
  const {
    companyId, bankTxId, bankAccountId, counterpartyAccountId,
    journalEntryId, amount, txDate, allocatedEntityName,
  } = input;

  try {
    await withSavepoint('bank_transfer_autolink', async () => {
      const cpAmt = -Number(amount);
      const cpTxRows = (await sql`
        SELECT id FROM bank_transactions
        WHERE company_id = ${companyId}::UUID
          AND bank_account_id = ${counterpartyAccountId}::UUID
          AND status = 'imported'
          AND ABS(amount - ${cpAmt}) < 0.01
          AND transaction_date BETWEEN (${txDate}::DATE - INTERVAL '2 days')
                                   AND (${txDate}::DATE + INTERVAL '2 days')
        ORDER BY ABS(transaction_date::DATE - ${txDate}::DATE) ASC, created_at DESC
        LIMIT 1
      `) as Row[];
      if (cpTxRows.length === 0) return;

      const cpTxId = String(cpTxRows[0]!.id);
      // Find the JE line on the counterparty account side
      const cpJeLines = (await sql`
        SELECT id FROM gl_journal_lines
        WHERE journal_entry_id = ${journalEntryId}::UUID
          AND gl_account_id = ${counterpartyAccountId}::UUID
          AND company_id = ${companyId}::UUID
        LIMIT 1
      `) as Row[];
      const cpJeLineId = cpJeLines.length > 0 ? String(cpJeLines[0]!.id) : null;
      await sql`
        UPDATE bank_transactions
        SET status = 'allocated',
            allocation_type = 'transfer',
            matched_journal_line_id = ${cpJeLineId}::UUID,
            counterparty_account_id = ${bankAccountId}::UUID,
            transfer_journal_entry_id = ${journalEntryId}::UUID,
            allocated_entity_name = ${allocatedEntityName},
            updated_at = NOW(),
            allocation_batch_id = NULL
        WHERE id = ${cpTxId}::UUID
          AND company_id = ${companyId}::UUID
          AND status = 'imported'
      `;
      log.info('Auto-linked counterparty transfer transaction', { sourceTxId: bankTxId, cpTxId, jeId: journalEntryId }, 'accounting');
    });
  } catch (linkErr) {
    log.warn('Failed to auto-link counterparty transfer — non-fatal', { bankTxId, counterpartyAccountId, error: linkErr }, 'accounting');
  }
}
