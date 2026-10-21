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
 * ORDER, all inside the request transaction (and a savepoint), is the canonical
 * one: any bank line matched to the batch journal (`lockBankLegOf`, from an
 * unlocked peek), the batch row, the bills through `fetchBillCandidates`, then
 * the journal (`lockJournalAndUnmatch`). Every refusal about the books is raised
 * before the first write; a match landing mid-reversal is a retryable refusal
 * inside the savepoint, so a 4xx still commits nothing.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { claimUnderLockTimeout } from '../core/documentClaimLock';
import { reverseJournalEntry } from '../gl/journalEntryPostingService';
import { recomputeInvoiceStatus } from '../ar/invoiceStatusRecompute';
import { fetchBillCandidates, round2 } from './supplierAllocationLines';
import { toCents } from './billAllocatable';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';
import { assertSameJournal, lockBankLegOf, lockJournalAndUnmatch, type BankLeg } from './paymentJournalReversal';
import type { PostingActorOpts } from '../gl/journalEntryMeta';
import type { ReversalWithLateClaim } from '../gl/journalEntryPostingService';
import { RowLockTimeoutError, underFlowLockBudget } from '../core/rowLockBudget';
import { assertMayReverseMatchedLeg } from '../bank/bankReversalGate';
import { assertBatchNotSentToNetcash } from './netcashBatchGuard';

/** The batch is already reversed — a double-click's loser. Answered 409. */
export class BatchAlreadyReversedError extends Error {
  readonly code = 'BATCH_ALREADY_REVERSED';
  constructor(batchNumber: string) {
    super(`Batch ${batchNumber} has already been reversed.`);
    this.name = 'BatchAlreadyReversedError';
  }
}

/** `reversalEntryId` is null when the batch journal's chain was already out of the ledger: nothing was posted. */
export interface BatchReversal { reversalEntryId: string | null; billsReopened: number }
/** D10: what the bank reversal of the batch's line reports — members cancelled, money taken off bills, the contra. */
export interface BatchReversalDetail extends BatchReversal {
  membersCancelled: number; amountUnapplied: number; reversal: ReversalWithLateClaim | null;
}

export async function reverseBatch(companyId: string, batchId: string, userId: string): Promise<BatchReversal> {
  // Every lock under ONE budget, plain UPDATEs included (D8 round 10).
  return withSavepoint('reverse_payment_batch', () => underFlowLockBudget(`Batch ${batchId}`,
    () => reverseBatchInner(companyId, batchId, userId)));
}

async function reverseBatchInner(companyId: string, batchId: string, userId: string): Promise<BatchReversal> {
  // (1) The BANK LINE first, from an unlocked peek of the batch's journal — the
  // canonical order starts at the bank row. This also runs the pre-write
  // journal refusals (closed period, reconciled line).
  const peek = ((await sql`
    SELECT batch_number, gl_journal_entry_id FROM supplier_payment_batches
    WHERE id = ${batchId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[])[0];
  if (!peek) throw new Error('Batch not found');
  const peekedJournal = peek.gl_journal_entry_id ? String(peek.gl_journal_entry_id) : null;
  const leg = peekedJournal
    ? await lockBankLegOf(companyId, peekedJournal, `Batch ${String(peek.batch_number)}`)
    : null;
  // Step 2: a statement line MATCHED to the batch journal makes it a bank allocation — judged as the bank line's own
  // reverse is, before any write (the bank reversal reaches reverseBatchWithLeg already judged).
  const auditLeg = peekedJournal && leg ? await assertMayReverseMatchedLeg(companyId, peekedJournal, leg.bankLineIds, userId) : null;
  const { reversalEntryId, billsReopened } = await reverseBatchWithLeg(companyId, batchId, userId, peekedJournal, leg);
  await auditLeg?.();
  return { reversalEntryId, billsReopened };
}

/**
 * The batch reversal from step (2) on, its bank lines ALREADY locked by the caller: `reverseBatch` above, or the bank
 * reversal of a statement line matched to the batch journal's chain (D10 O3, bank/bankChainLineReversal), which
 * locks every line of the chain in id order first and builds the leg itself — the same order, bank lines -> batch
 * -> members -> bills -> journal. Must run inside the caller's savepoint and flow lock budget.
 */
export async function reverseBatchWithLeg(
  companyId: string, batchId: string, userId: string, peekedJournal: string | null, leg: BankLeg | null,
  opts?: PostingActorOpts & { reversalDate?: string },
): Promise<BatchReversalDetail> {
  // (2) The batch row. A second click waits here and then reads 'reversed'.
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
  // AP-01: a batch Netcash may hold is not reversed: its bills would reopen and be paid again.
  await assertBatchNotSentToNetcash(companyId, batchId, number, 'reversed');
  const journalId = batch.gl_journal_entry_id ? String(batch.gl_journal_entry_id) : null;
  if (!journalId || !leg) throw new SupplierPaymentRefusal(`Batch ${number} has no journal to reverse.`);
  assertSameJournal(peekedJournal, journalId);
  // A journal chain already OUT of the ledger (reversed from the GL) is not a
  // refusal (D8 round 5): the batch's documents are still voided and its bills
  // reopened, and nothing is posted — as the single void does. Refusing left
  // the bills paid against a ledger that holds no payment.
  if (leg.allocatedLineIds.length > 0) {
    throw new SupplierPaymentRefusal(`Batch ${number}'s journal is claimed by an allocated bank line — undo that first.`);
  }

  // The member payments locked BEFORE their bills (D8 round 10, brk-d8c O4): a member's MCP void takes payment ->
  // bill, and this took bills -> journal -> members, so the pair deadlocked.
  const members = (await sql`
    SELECT id, payment_number, status FROM supplier_payments
    WHERE batch_id = ${batchId}::UUID AND company_id = ${companyId}::UUID
    ORDER BY id FOR UPDATE
  `) as DbRow[];
  const unsettled = members.find((m) => m.status !== 'processed');
  if (unsettled) {
    // 'reconciled' is the single-void rule; anything else means the batch and
    // its members disagree, which this must not paper over.
    throw new SupplierPaymentRefusal(`Payment ${String(unsettled.payment_number)} in batch ${number} is `
      + `${String(unsettled.status)} — the batch cannot be reversed.`);
  }

  // The bills, locked in the shared order, each by what THIS batch put on it.
  const perBill = (await sql`
    SELECT pa.invoice_id, SUM(pa.amount_allocated) AS amount
    FROM payment_allocations pa JOIN supplier_payments sp ON sp.id = pa.payment_id
    WHERE sp.batch_id = ${batchId}::UUID AND sp.company_id = ${companyId}::UUID
    GROUP BY pa.invoice_id ORDER BY pa.invoice_id
  `) as DbRow[];
  const bills = await fetchBillCandidates(companyId, null, perBill.map((r) => String(r.invoice_id))).catch((err: unknown) => {
    // Its one retryable refusal is a held bill — a lock timeout on this D8 flow, 503 at the route, not 409 (round 18).
    if (err instanceof SupplierPaymentRefusal && err.retryable) throw new RowLockTimeoutError(`Batch ${number}`);
    throw err;
  });
  for (const r of perBill) {
    const bill = bills.get(String(r.invoice_id));
    if (!bill || toCents(Number(bill.amount_paid ?? 0)) < toCents(Number(r.amount))) {
      throw new SupplierPaymentRefusal(`A bill paid by batch ${number} no longer shows that payment — `
        + 'the batch cannot be reversed automatically.');
    }
  }

  // ── writes ────────────────────────────────────────────────────────────────
  for (const r of perBill) {
    await sql`
      UPDATE supplier_invoices SET amount_paid = amount_paid - ${round2(Number(r.amount))}, updated_at = NOW()
      WHERE id = ${String(r.invoice_id)}::UUID AND company_id = ${companyId}::UUID
    `;
    await recomputeInvoiceStatus(companyId, 'supplier', String(r.invoice_id));
  }
  // (3) The journal last: locked, re-checked for a bank line matched meanwhile, unmatched.
  // The bank line is freed even when the chain is already out (D8 round 6).
  await lockJournalAndUnmatch(companyId, journalId, leg, `Batch ${number}`);
  const reversal = leg.alreadyReversed ? null : await reverseJournalEntry(companyId, leg.reverseId, userId, opts); // the head (D8)
  const cancelled = (await sql`
    UPDATE supplier_payments SET status = 'cancelled', updated_at = NOW()
    WHERE batch_id = ${batchId}::UUID AND company_id = ${companyId}::UUID AND status = 'processed'
    RETURNING id
  `) as DbRow[];
  await sql`
    UPDATE supplier_payment_batches SET status = 'reversed', updated_at = NOW()
    WHERE id = ${batchId}::UUID AND company_id = ${companyId}::UUID AND status = 'processed'
  `;
  const reversalEntryId = reversal ? String(reversal.id) : null;
  log.info('Reversed supplier payment batch', {
    batchId, userId, journalId, reversalEntryId, bills: perBill.length, bankLines: leg.bankLineIds.length,
  }, 'accounting');
  return {
    reversalEntryId, billsReopened: perBill.length, membersCancelled: cancelled.length,
    amountUnapplied: round2(perBill.reduce((t, r) => t + Number(r.amount), 0)), reversal,
  };
}
