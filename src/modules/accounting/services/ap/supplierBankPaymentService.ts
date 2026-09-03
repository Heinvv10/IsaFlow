/**
 * Allocating an outgoing bank line to the supplier bills it settles, in one
 * operation.
 *
 * THE ASYMMETRY THIS CLOSES. `allocateTransaction` with `allocType='customer'`
 * inserts a `customer_payments` row alongside its journal, so a receipt at
 * least has a document. With `allocType='supplier'` it inserts NOTHING — it
 * posts DR Accounts Payable / CR Bank and calls `recordPaymentMatch`, which
 * sets a `payment_matched` boolean and leaves `amount_paid` and `status`
 * untouched. There is no payment document at all, so the bill can never be
 * reconciled back to the cash that paid it. That is how seventeen bills read as
 * wholly open against a Sage book showing every one paid.
 *
 * So this creates the missing document: one `supplier_payments` row at status
 * `processed`, carrying the journal the allocation posted, and then applies it
 * through the same service the "cash already in the ledger" path uses. It does
 * NOT post a second journal — `allocateTransaction` posted the only one.
 *
 * Guard order is load-bearing. `validateBankSupplierPayment` reads and refuses
 * everything BEFORE `allocateTransaction`, so an MCP handler can answer with
 * `toolError` while nothing has been written. After that call nothing is
 * caught: the savepoint unwinds on a throw and not on a returned error.
 */

import { sql } from '@/lib/neon';
import type { PostingActorOpts } from '../gl/journalEntryMeta';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fetchBankTransaction } from '../bank/bankMatchDbQueries';
import { getBankTransactionStatus } from '../bank/bankTransactionLookupService';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { allocateTransaction } from '../bank/bankAllocationService';
import { resolveUserUuid } from '../gl/journalEntryCrudService';
import {
  EPS,
  planSupplierAllocationLines,
  round2,
  type SupplierAllocationInput,
  type SupplierApplicationLine,
} from './supplierAllocationLines';
import {
  applySupplierPaymentPlan,
  planSupplierPaymentApplication,
} from './supplierPaymentApplicationService';

export interface BankSupplierPaymentValidation {
  bankTxId: string;
  /** The absolute value of the bank line. The journal posts this. */
  paymentAmount: number;
  transactionDate: string;
  supplierId: string;
  lines: SupplierApplicationLine[];
  allocatedTotal: number;
  unappliedRemainder: number;
}

export interface BankSupplierPaymentResult extends BankSupplierPaymentValidation {
  journalEntryId: string;
  supplierPaymentId: string;
  paymentNumber: string;
  paymentStatus: string;
}

/** Every refusal this operation can make, answered from READS alone. */
export async function validateBankSupplierPayment(
  companyId: string,
  bankTxId: string,
  allocations: readonly SupplierAllocationInput[],
): Promise<BankSupplierPaymentValidation> {
  const tx = await fetchBankTransaction(bankTxId, companyId);
  // Same wording as a genuine miss.
  if (!tx) throw new Error(`Bank transaction ${bankTxId} not found`);
  if (tx.amount >= 0) {
    throw new Error(
      `Bank transaction ${bankTxId} is money IN (R${tx.amount.toFixed(2)}). `
      + 'A supplier payment is money out; use apply_receipt_to_invoice for a receipt.',
    );
  }

  const status = await getBankTransactionStatus(companyId, bankTxId);
  if (status !== 'imported') {
    throw new Error(
      `Bank transaction ${bankTxId} is "${status ?? 'unknown'}" and cannot be allocated. `
      + 'Only an unallocated (imported) line can be matched to a payment; reverse the existing '
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

  const paymentAmount = Math.abs(tx.amount);
  const { supplierId, lines } = await planSupplierAllocationLines(companyId, allocations, {
    paymentId: null,
    supplierId: null,
  });

  const allocatedTotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  if (allocatedTotal > paymentAmount + EPS) {
    throw new Error(
      `Allocations total R${allocatedTotal.toFixed(2)} but the bank line is only `
      + `R${paymentAmount.toFixed(2)}. The bills would be settled with cash that never left the bank.`,
    );
  }

  return {
    bankTxId,
    paymentAmount,
    transactionDate: tx.transactionDate,
    supplierId,
    lines,
    allocatedTotal,
    unappliedRemainder: round2(paymentAmount - allocatedTotal),
  };
}

export async function applyBankLineToSupplierInvoices(
  companyId: string,
  params: {
    bankTxId: string;
    userId: string;
    allocations: readonly SupplierAllocationInput[];
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
): Promise<BankSupplierPaymentResult> {
  const { bankTxId, userId, allocations } = params;
  const validation = await validateBankSupplierPayment(companyId, bankTxId, allocations);

  const description = validation.lines.length === 1
    ? `Payment allocated to ${validation.lines[0]!.invoiceNumber}`
    : `Payment allocated to ${validation.lines.length} supplier invoices`;

  const { journalEntryId } = await allocateTransaction(
    companyId,
    bankTxId,
    null,
    userId,
    description,
    'supplier',
    validation.supplierId,
    undefined,
    undefined,
    undefined,
    undefined,
    validation.lines[0]!.invoiceId,
    params.postingOpts ?? (params.postingAgent ? { postingAgent: params.postingAgent } : undefined),
  );

  // The document allocateTransaction does not create on the AP side. Status is
  // `processed` because the journal HAS posted — it is the state
  // processSupplierPayment would have left the payment in — and it carries that
  // journal so the pair can be reversed together. `payment_number` is left to
  // trg_sp_payment_number.
  //
  // `created_by` must be a real uuid: the column is uuid-typed and a GoTrue
  // user id is not always one, which is the same trap allocateTransaction works
  // around for customer_payments.
  const createdBy = await resolveUserUuid(userId);
  const bankAccountRows = (await sql`
    SELECT bank_account_id FROM bank_transactions
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const bankAccountId = bankAccountRows[0]?.bank_account_id
    ? String(bankAccountRows[0]!.bank_account_id)
    : null;

  const paymentRows = (await sql`
    INSERT INTO supplier_payments (
      company_id, supplier_id, payment_date, total_amount, payment_method,
      bank_account_id, reference, description, status, gl_journal_entry_id,
      created_by, approved_by, approved_at, processed_at
    ) VALUES (
      ${companyId}::UUID, ${validation.supplierId}::UUID, ${validation.transactionDate},
      ${validation.paymentAmount}, 'eft',
      ${bankAccountId}::UUID, ${bankTxId}, ${description}, 'processed',
      ${journalEntryId}::UUID,
      ${createdBy}::UUID, ${createdBy}::UUID, NOW(), NOW()
    )
    RETURNING id, payment_number
  `) as DbRow[];
  const paymentId = String(paymentRows[0]!.id);

  const plan = await planSupplierPaymentApplication(companyId, paymentId, allocations);
  await applySupplierPaymentPlan(companyId, plan, userId);

  log.info('Allocated bank line to supplier invoices', {
    bankTxId,
    journalEntryId,
    supplierPaymentId: paymentId,
    lines: plan.lines.length,
    allocatedTotal: validation.allocatedTotal,
    unappliedRemainder: validation.unappliedRemainder,
  }, 'accounting');

  return {
    ...validation,
    lines: plan.lines,
    journalEntryId,
    supplierPaymentId: paymentId,
    paymentNumber: paymentRows[0]!.payment_number
      ? String(paymentRows[0]!.payment_number)
      : '',
    paymentStatus: plan.paymentStatusAfter,
  };
}
