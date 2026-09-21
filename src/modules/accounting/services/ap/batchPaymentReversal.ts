/**
 * Reverse a PROCESSED supplier payment batch — the only way a batch member's
 * money moves back, because a member moves money only through its batch
 * (`supplierPaymentGates.ts` refuses a single-payment void of one).
 *
 * WHY ONE BATCH-LEVEL UNWIND AND NOT A VOID PER MEMBER. The members carry no
 * journal of their own: `processBatch` posts ONE journal (DR AP / CR Bank for
 * the batch total) and applies every member's allocations. Voiding member by
 * member would need N partial reversals of that one journal, which the
 * one-reversal-per-journal guarantee (`reverseJournalEntry`'s claim on
 * `reversed_at`, and migration 619's unique index on `reversal_of_id`) exists
 * to forbid. So this does what single void does, once: un-apply each bill by
 * exactly THIS batch's allocations to it, then `reverseJournalEntry` on the
 * batch journal — the same primitive, so no path can post a second contra.
 *
 * ORDER, all inside the request transaction (and a savepoint): the batch row
 * (document first, as process and cancel take it), then any bank line matched
 * to the batch journal, then the bills through `fetchBillCandidates` (the id
 * order every settlement path uses), then the GL. Every refusal is raised
 * before the first write, so a 4xx commits nothing.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { claimUnderLockTimeout } from '../core/documentClaimLock';
import { lockBankTransactionForUpdate } from '../bank/bankTxLock';
import { unmatchTransaction } from '../bank/bankTxStatusMutations';
import { reverseJournalEntry } from '../gl/journalEntryPostingService';
import { resolveReversalDate } from '../gl/journalEntryReversalDate';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { recomputeInvoiceStatus } from '../ar/invoiceStatusRecompute';
import { fetchBillCandidates, round2 } from './supplierAllocationLines';
import { toCents } from './billAllocatable';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';

/** The batch is already reversed — a double-click's loser. Answered 409. */
export class BatchAlreadyReversedError extends Error {
  readonly code = 'BATCH_ALREADY_REVERSED';
  constructor(batchNumber: string) {
    super(`Batch ${batchNumber} has already been reversed.`);
    this.name = 'BatchAlreadyReversedError';
  }
}

export interface BatchReversal { reversalEntryId: string; billsReopened: number }

export async function reverseBatch(companyId: string, batchId: string, userId: string): Promise<BatchReversal> {
  return withSavepoint('reverse_payment_batch', () => reverseBatchInner(companyId, batchId, userId));
}

async function reverseBatchInner(companyId: string, batchId: string, userId: string): Promise<BatchReversal> {
  // (1) The batch row. A second click waits here and then reads 'reversed'.
  const batch = (await claimUnderLockTimeout('payment batch', async () => (await sql`
    SELECT batch_number, status, gl_journal_entry_id FROM supplier_payment_batches
    WHERE id = ${batchId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `) as DbRow[]))[0];
  if (!batch) throw new Error('Batch not found');
  const number = String(batch.batch_number);
  if (batch.status === 'reversed') throw new BatchAlreadyReversedError(number);
  if (batch.status !== 'processed') {
    throw new SupplierPaymentRefusal(`Batch ${number} is ${String(batch.status)} — only a processed batch can be reversed.`);
  }
  const journalId = batch.gl_journal_entry_id ? String(batch.gl_journal_entry_id) : null;
  if (!journalId) throw new SupplierPaymentRefusal(`Batch ${number} has no journal to reverse.`);

  const members = (await sql`
    SELECT id, payment_number, status FROM supplier_payments
    WHERE batch_id = ${batchId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const unsettled = members.find((m) => m.status !== 'processed');
  if (unsettled) {
    // 'reconciled' is the single-void rule; anything else means the batch and
    // its members disagree, which this must not paper over.
    throw new SupplierPaymentRefusal(`Payment ${String(unsettled.payment_number)} in batch ${number} is `
      + `${String(unsettled.status)} — the batch cannot be reversed.`);
  }

  // (2) The bank leg: a bank line matched to this journal. Reconciled → refuse;
  // matched → unmatched below, so the statement line is free to match again.
  const bankLines = (await sql`
    SELECT bt.id FROM bank_transactions bt
    JOIN gl_journal_lines l ON l.id = bt.matched_journal_line_id
    WHERE l.journal_entry_id = ${journalId}::UUID AND bt.company_id = ${companyId}::UUID
    ORDER BY bt.id
  `) as DbRow[];
  for (const line of bankLines) {
    const row = await lockBankTransactionForUpdate(companyId, String(line.id));
    if (row && (row.status === 'reconciled' || row.reconciliation_id)) {
      throw new SupplierPaymentRefusal(`Batch ${number} is on a bank reconciliation — remove it from the `
        + 'reconciliation before reversing.');
    }
    if (row && row.status === 'allocated') {
      throw new SupplierPaymentRefusal(`Batch ${number}'s journal is claimed by an allocated bank line — undo that first.`);
    }
  }

  // (3) The reversal's date, decided exactly as `reverseJournalEntry` will: the
  // original date if its period is open, else today. Single void lets a closed
  // period surface as a failed post (500, rolled back); here it is a 400, first.
  const je = (await sql`
    SELECT entry_date, reversed_at FROM gl_journal_entries
    WHERE id = ${journalId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!je[0]) throw new SupplierPaymentRefusal(`Batch ${number}'s journal was not found.`);
  if (je[0].reversed_at) throw new BatchAlreadyReversedError(number);
  const reversalDate = await resolveReversalDate(companyId, fmtDate(je[0].entry_date), undefined);
  if ((await getPeriodStatusForDate(companyId, reversalDate)) !== 'open') {
    throw new SupplierPaymentRefusal(`The reversal would be dated ${reversalDate}, which is not in an open `
      + 'fiscal period — re-open it or create the fiscal year first.');
  }

  // (4) The bills, locked in the shared order, each by what THIS batch put on it.
  const perBill = (await sql`
    SELECT pa.invoice_id, SUM(pa.amount_allocated) AS amount
    FROM payment_allocations pa JOIN supplier_payments sp ON sp.id = pa.payment_id
    WHERE sp.batch_id = ${batchId}::UUID AND sp.company_id = ${companyId}::UUID
    GROUP BY pa.invoice_id ORDER BY pa.invoice_id
  `) as DbRow[];
  const bills = await fetchBillCandidates(companyId, null, perBill.map((r) => String(r.invoice_id)));
  for (const r of perBill) {
    const bill = bills.get(String(r.invoice_id));
    if (!bill || toCents(Number(bill.amount_paid ?? 0)) < toCents(Number(r.amount))) {
      throw new SupplierPaymentRefusal(`A bill paid by batch ${number} no longer shows that payment — `
        + 'the batch cannot be reversed automatically.');
    }
  }

  // ── writes ────────────────────────────────────────────────────────────────
  for (const line of bankLines) await unmatchTransaction(companyId, String(line.id));
  for (const r of perBill) {
    await sql`
      UPDATE supplier_invoices SET amount_paid = amount_paid - ${round2(Number(r.amount))}, updated_at = NOW()
      WHERE id = ${String(r.invoice_id)}::UUID AND company_id = ${companyId}::UUID
    `;
    await recomputeInvoiceStatus(companyId, 'supplier', String(r.invoice_id));
  }
  const reversal = await reverseJournalEntry(companyId, journalId, userId);
  await sql`
    UPDATE supplier_payments SET status = 'cancelled', updated_at = NOW()
    WHERE batch_id = ${batchId}::UUID AND company_id = ${companyId}::UUID AND status = 'processed'
  `;
  await sql`
    UPDATE supplier_payment_batches SET status = 'reversed', updated_at = NOW()
    WHERE id = ${batchId}::UUID AND company_id = ${companyId}::UUID AND status = 'processed'
  `;
  log.info('Reversed supplier payment batch', {
    batchId, userId, journalId, reversalEntryId: reversal.id, bills: perBill.length, bankLines: bankLines.length,
  }, 'accounting');
  return { reversalEntryId: String(reversal.id), billsReopened: perBill.length };
}
