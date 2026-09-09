/** Customer bank matching executes its immutable application plan inside the bank parent effect. */
import { sql } from '@/lib/neon';
import type { PostingActorOpts } from '../gl/journalEntryMeta';
import type { DbRow } from '@/lib/neon';
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
    /**
     * The FULL actor identity. `postingAgent` alone loses `actorType` and
     * `actorTokenJti` (migrations 530/531), and a posting without the token
     * jti drops out of the token-scoped view of `list_agent_postings` — the
     * control surface every other agent write is audited through. Kept
     * alongside `postingAgent` rather than replacing it so existing callers
     * are untouched; this wins when both are given.
     */
    postingOpts?: PostingActorOpts;
  },
): Promise<ConfirmReceiptMatchResult> {
  const {bankTxId,userId,allocations}=params;
  const validation=await validateBankReceiptApplication(companyId,bankTxId,allocations);
  const {journalEntryId}=await allocateTransaction(companyId,bankTxId,null,userId,'Matched customer receipt','customer',validation.customerId,
   undefined,undefined,undefined,undefined,undefined,{...params.postingOpts,autoApply:false,applications:allocations.map(a=>({invoiceId:a.invoiceId,amount:String(a.amount)}))});
  const rows=await sql`SELECT id,status FROM customer_payments WHERE company_id=${companyId}::uuid AND gl_journal_entry_id=${journalEntryId}::uuid` as DbRow[];
  if(rows.length!==1)throw new Error('Controlled bank receipt association unavailable');
  return{...validation,journalEntryId,customerPaymentId:String(rows[0]!.id),paymentStatus:String(rows[0]!.status)};
}
