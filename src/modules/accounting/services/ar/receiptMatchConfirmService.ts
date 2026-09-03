/**
 * Confirming a receipt match: allocate an imported bank line to the customer
 * invoices it settles, in one operation.
 *
 * Split out of `receiptMatchService.ts` (which was over the 300-line cap) and
 * WIDENED from one invoice to many at the same time. One receipt routinely pays
 * several invoices, and the single-invoice form left the remainder of the bank
 * line sitting on the AR control account with nothing recording what it was
 * for — the same unapplied-receipt state the whole workstream exists to remove.
 *
 * ONE journal is posted for the WHOLE bank line, by `allocateTransaction`:
 * DR Bank / CR Accounts Receivable at the transaction's own amount. The
 * allocations then move the subledger. Allocating less than the full line is
 * allowed and leaves a genuine unapplied remainder on the receipt, which
 * `list_unapplied_receipts` will report; allocating MORE is refused, because
 * the invoices would be credited with cash the journal never received.
 *
 * Guard order is load-bearing. `validateBankReceiptApplication` reads and
 * refuses everything BEFORE `allocateTransaction` is called, so an MCP handler
 * can answer with `toolError` while nothing has been written. After that first
 * write every failure must propagate: the registry's savepoint rolls back on a
 * throw and not on a returned error, and a refusal frees the idempotency key
 * for a retry that would post the allocation a second time.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fetchBankTransaction } from '../bank/bankMatchDbQueries';
import { getBankTransactionStatus } from '../bank/bankTransactionLookupService';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { allocateTransaction } from '../bank/bankAllocationService';
import {
  EPS,
  planAllocationLines,
  round2,
  type ReceiptAllocationInput,
  type ReceiptApplicationLine,
} from './receiptAllocationLines';
import { applyReceiptPlan, planReceiptApplication } from './receiptApplicationService';

export interface BankReceiptValidation {
  bankTxId: string;
  /** The bank line's own amount. The journal posts this, not the allocated total. */
  receiptAmount: number;
  transactionDate: string;
  customerId: string;
  lines: ReceiptApplicationLine[];
  allocatedTotal: number;
  /** Receipt amount less the allocations — real, and reported as unapplied. */
  unappliedRemainder: number;
}

export interface ConfirmReceiptMatchResult extends BankReceiptValidation {
  journalEntryId: string;
  customerPaymentId: string;
  paymentStatus: string;
}

/**
 * Every refusal this operation can make, answered from READS alone.
 *
 * Call this before `confirmReceiptMatch` when the caller needs to distinguish a
 * refusal from a failure — an MCP tool must, because only a pre-write refusal
 * may return `toolError`.
 */
export async function validateBankReceiptApplication(
  companyId: string,
  bankTxId: string,
  allocations: readonly ReceiptAllocationInput[],
): Promise<BankReceiptValidation> {
  const tx = await fetchBankTransaction(bankTxId, companyId);
  // Same wording as a genuine miss — a transaction in another tenant must not
  // be distinguishable from one that does not exist.
  if (!tx) throw new Error(`Bank transaction ${bankTxId} not found`);
  if (tx.amount <= 0) {
    throw new Error(
      `Bank transaction ${bankTxId} is money OUT (R${tx.amount.toFixed(2)}). `
      + 'A customer receipt is money in; use apply_payment_to_supplier_invoice for a payment.',
    );
  }

  const status = await getBankTransactionStatus(companyId, bankTxId);
  if (status !== 'imported') {
    throw new Error(
      `Bank transaction ${bankTxId} is "${status ?? 'unknown'}" and cannot be allocated. `
      + 'Only an unallocated (imported) line can be matched to a receipt; reverse the existing '
      + 'allocation first if it is wrong.',
    );
  }

  // PERIOD GUARD, pre-write. The journal below is dated to the bank line, and
  // `postJournalEntry` inside `allocateTransaction` raises
  // ClosedFiscalPeriodError — but by then the entry has been INSERTed, so the
  // failure arrives after the first write and reaches the agent as a generic
  // failure naming nothing. Answering it from a read here makes it a refusal
  // with a remedy in it.
  //
  // `no_period` and `closed` get different messages because the remedies
  // differ: create the fiscal year, versus re-open the period. A NULL
  // fiscal_period_id is the worse of the two — createJournalEntry leaves the
  // column NULL when no period covers the date, and the entry then sits
  // permanently outside the trial balance, the VAT201 and the AFS.
  const period = await getPeriodStatusForDate(companyId, tx.transactionDate);
  if (period === 'no_period') {
    throw new Error(
      `No fiscal period covers ${tx.transactionDate}, the date of this bank line. Create the `
      + 'fiscal year first — posting outside every period would leave the journal invisible to '
      + 'the trial balance, the VAT201 and the AFS.',
    );
  }
  if (period !== 'open') {
    throw new Error(
      `The fiscal period covering ${tx.transactionDate}, the date of this bank line, is `
      + `${period}. Re-open it before allocating into it.`,
    );
  }

  const { customerId, lines } = await planAllocationLines(companyId, allocations, {
    paymentId: null,
    customerId: null,
  });

  const allocatedTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  if (allocatedTotal > tx.amount + EPS) {
    throw new Error(
      `Allocations total R${allocatedTotal.toFixed(2)} but the bank line is only `
      + `R${tx.amount.toFixed(2)}. The invoices would be credited with cash the journal never received.`,
    );
  }

  return {
    bankTxId,
    receiptAmount: tx.amount,
    transactionDate: tx.transactionDate,
    customerId,
    lines,
    allocatedTotal,
    unappliedRemainder: round2(tx.amount - allocatedTotal),
  };
}

/**
 * Allocate the bank line and apply it to the invoices.
 *
 * Steps, in this order and for these reasons:
 *   1. re-validate (cheap, and the only refusals left are races);
 *   2. `allocateTransaction(allocType='customer')` — posts DR Bank / CR AR for
 *      the FULL line, flips the row to `allocated`, and inserts a `confirmed`
 *      `customer_payments` row. This is the step that was already correct and
 *      is not reimplemented here;
 *   3. plan and apply the allocations against that new payment, through the
 *      same service the "cash already in the ledger" path uses. One
 *      implementation of "may this receipt settle this invoice", not two.
 *
 * From step 2 onward every failure THROWS. Nothing here catches.
 */
export async function confirmReceiptMatch(
  companyId: string,
  params: {
    bankTxId: string;
    userId: string;
    allocations: readonly ReceiptAllocationInput[];
    postingAgent?: string;
  },
): Promise<ConfirmReceiptMatchResult> {
  const { bankTxId, userId, allocations } = params;
  const validation = await validateBankReceiptApplication(companyId, bankTxId, allocations);

  const description = validation.lines.length === 1
    ? `Receipt allocated to ${validation.lines[0]!.invoiceNumber}`
    : `Receipt allocated to ${validation.lines.length} invoices`;

  const { journalEntryId } = await allocateTransaction(
    companyId,
    bankTxId,
    null,
    userId,
    description,
    'customer',
    validation.customerId,
    undefined,
    undefined,
    undefined,
    undefined,
    validation.lines[0]!.invoiceId,
    params.postingAgent ? { postingAgent: params.postingAgent } : undefined,
  );

  const paymentRows = (await sql`
    SELECT id FROM customer_payments
    WHERE company_id = ${companyId}::UUID
      AND gl_journal_entry_id = ${journalEntryId}::UUID
    ORDER BY created_at DESC LIMIT 1
  `) as DbRow[];
  if (paymentRows.length === 0) {
    // allocateTransaction skips the customer_payments INSERT when it cannot
    // resolve a uuid-shaped user. Without that row there is nothing to allocate
    // against and the receipt would post to the control account and vanish —
    // exactly the state this workstream exists to remove. Throw so the
    // savepoint unwinds the journal too.
    throw new Error(
      'The bank allocation posted but no customer payment record was created, so the receipt '
      + 'could not be applied to any invoice. Nothing was kept.',
    );
  }
  const customerPaymentId = String(paymentRows[0]!.id);

  const plan = await planReceiptApplication(companyId, customerPaymentId, allocations);
  await applyReceiptPlan(companyId, plan, userId);

  log.info('Confirmed receipt match', {
    bankTxId,
    journalEntryId,
    customerPaymentId,
    lines: plan.lines.length,
    allocatedTotal: validation.allocatedTotal,
    unappliedRemainder: validation.unappliedRemainder,
  }, 'accounting');

  return {
    ...validation,
    lines: plan.lines,
    journalEntryId,
    customerPaymentId,
    paymentStatus: plan.paymentStatusAfter,
  };
}
