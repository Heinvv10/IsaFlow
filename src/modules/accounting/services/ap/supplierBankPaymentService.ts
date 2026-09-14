/** Supplier bank matching executes its immutable application plan inside the bank parent effect. */
import { sql } from '@/lib/neon';
import type { PostingActorOpts } from '../gl/journalEntryMeta';
import type { DbRow } from '@/lib/neon';
import { fetchBankTransaction } from '../bank/bankMatchDbQueries';
import { getBankTransactionStatus } from '../bank/bankTransactionLookupService';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { allocateTransaction } from '../bank/bankAllocationService';
import {
  EPS,
  planSupplierAllocationLines,
  round2,
  type SupplierAllocationInput,
  type SupplierApplicationLine,
} from './supplierAllocationLines';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';

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

/**
 * Every refusal this operation can make, answered from READS alone.
 *
 * Refusals — here and in `planSupplierAllocationLines` beneath — are thrown as
 * `SupplierPaymentRefusal`, and nothing else is. A caller that answers a refusal
 * with a 4xx must catch THAT and re-throw the rest: a dropped connection or a
 * `25P02` reported as a refusal both leaks raw Postgres text to the client and
 * answers with a status `withAuth` COMMITs.
 */
export async function validateBankSupplierPayment(
  companyId: string,
  bankTxId: string,
  allocations: readonly SupplierAllocationInput[],
): Promise<BankSupplierPaymentValidation> {
  const tx = await fetchBankTransaction(bankTxId, companyId);
  // Same wording as a genuine miss.
  if (!tx) throw new SupplierPaymentRefusal(`Bank transaction ${bankTxId} not found`);
  if (tx.amount >= 0) {
    throw new SupplierPaymentRefusal(
      `Bank transaction ${bankTxId} is money IN (R${tx.amount.toFixed(2)}). `
      + 'A supplier payment is money out; use apply_receipt_to_invoice for a receipt.',
    );
  }

  const status = await getBankTransactionStatus(companyId, bankTxId);
  if (status !== 'imported') {
    throw new SupplierPaymentRefusal(
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
    throw new SupplierPaymentRefusal(
      `No fiscal period covers ${tx.transactionDate}, the date of this bank line. Create the `
      + 'fiscal year first — posting outside every period would leave the journal invisible to '
      + 'the trial balance, the VAT201 and the AFS.',
    );
  }
  if (period !== 'open') {
    throw new SupplierPaymentRefusal(
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
    throw new SupplierPaymentRefusal(
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
    /**
     * The result of `validateBankSupplierPayment` when the CALLER has already
     * run it — a route that must answer a refusal with a 4xx has to, because
     * every refusal must be decided before this function's first write. Passing
     * it through saves re-reading the line, its status, the period and the bill
     * plan a second time inside the same request transaction, and leaves one
     * decision rather than two that could differ. Omit it and the validation is
     * run here, which is what every other caller does.
     */
    validation?: BankSupplierPaymentValidation;
  },
): Promise<BankSupplierPaymentResult> {
  const {bankTxId,userId,allocations}=params;
  // The caller's own validation wins when it has one: a route that must answer
  // a refusal with a 4xx has already run it, and re-deciding here is a second
  // decision that could differ from the one the caller answered on.
  const validation=params.validation??await validateBankSupplierPayment(companyId,bankTxId,allocations);
  const {journalEntryId}=await allocateTransaction(companyId,bankTxId,null,userId,'Matched supplier payment','supplier',validation.supplierId,
   undefined,undefined,undefined,undefined,undefined,{...params.postingOpts,postingAgent:params.postingOpts?.postingAgent??params.postingAgent,autoApply:false,applications:allocations.map(a=>({invoiceId:a.invoiceId,amount:String(a.amount)}))});
  const rows=await sql`SELECT id,status,payment_number FROM supplier_payments WHERE company_id=${companyId}::uuid AND gl_journal_entry_id=${journalEntryId}::uuid` as DbRow[];
  if(rows.length!==1)throw new Error('Controlled bank payment association unavailable');
  return{...validation,journalEntryId,supplierPaymentId:String(rows[0]!.id),paymentNumber:String(rows[0]!.payment_number??''),paymentStatus:String(rows[0]!.status)};
}
