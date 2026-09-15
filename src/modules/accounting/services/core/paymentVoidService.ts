/**
 * Void a payment document — a customer receipt (CP) or a supplier payment.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Until now the only way to undo applied cash was `reverse_bank_allocation`,
 * addressed by BANK TRANSACTION. A receipt created by
 * `apply_receipt_to_invoice` against no bank line had no undo at all, and
 * `cancelCustomerPayment` refuses anything that is not `confirmed` — precisely
 * the status a FULLY applied receipt does not have, because
 * `receiptApplicationService.ts` promotes it to `reconciled`. So the better the
 * application worked, the more certainly it could not be undone.
 *
 * ── THE THREE SHAPES ────────────────────────────────────────────────────────
 *
 *   1. It settles a BANK line. `reverseReconciledTransaction` already does the
 *      whole job — unwind, contra, and return the bank line to `imported` — so
 *      this delegates rather than reimplementing it; reimplementing would also
 *      leave the bank line `allocated` against a journal that no longer exists.
 *   2. It has a journal but no bank line. Unwind, then reverse the journal.
 *   3. It has no journal (never posted). Unwind only.
 *
 * ── ORDER IS LOAD-BEARING ───────────────────────────────────────────────────
 *
 * The unwind runs BEFORE the journal is reversed, for the reason in
 * `bankAllocationUnwind.ts`: reversing first returns the credit to the AR/AP
 * control account while the invoice still reads as settled, widening the
 * subledger-to-control gap behind an ordinary-looking reversal.
 *
 * ── SO IS THE LOCK ORDER ────────────────────────────────────────────────────
 *
 * Shape 1 locks two rows. `reverseReconciledTransaction`, which it delegates to,
 * takes the bank line first and reaches the payment afterwards through
 * `unwindOnePayment`'s `UPDATE …_payments`; locking the payment first here is
 * the inverse, so a `void_receipt` on P racing a `reverse_bank_allocation` on
 * the line P settles would hold one row each and deadlock. The line is
 * therefore locked FIRST, off an UNLOCKED read. Order: `bank/.claude.md`.
 *
 * Two consequences of resolving the line before the document, both deliberate.
 * `not_found` is decided from that unlocked peek — a row that does not exist
 * for this tenant cannot appear mid-request, and `loadPayment` answers it again
 * under the lock. And `ambiguous_bank_lines` now outranks `already_cancelled`
 * and `not_applied`, because it is settled before the status is read; a
 * cancelled payment on a two-bank-line journal reports the journal, not the
 * status. Nothing pins that precedence — if a caller comes to depend on the
 * status answer, move the resolution back below `loadPayment` and re-order the
 * locks some other way, do not read this as accidental.
 *
 * ── AND THE WRITES ARE NOT DONE HERE ────────────────────────────────────────
 *
 * Payment-addressed inverse ADAPTER. Shapes 2 and 3 no longer unwind and
 * reverse in-line: every economic write belongs to the approved domain service
 * (`cancelCustomerPayment` / `voidSupplierPayment`), so the inverse carries the
 * same approval, receipt and evidence as the forward posting. The shape-1
 * delegation to `reverseReconciledTransaction` is unchanged, fenced by
 * `assertBankPaymentInverseIdentity`.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertEffectivePermission } from '@/lib/auth/effectivePermissions';
import {
  PaymentPostedDuringVoidError,
  lockCustomerPaymentForUpdate,
  lockSupplierPaymentForUpdate,
} from './paymentLock';
import { requireControlTx } from '../controls/context';
import { assertBankPaymentInverseIdentity } from '../controls/bankChildReversalGuard';
import { reverseReconciledTransaction } from '../bank/bankAllocationService';
import { lockBankTransactionForUpdate } from '../bank/bankTxLock';
import { cancelCustomerPayment } from '../ar/customerPaymentAllocationService';
import { voidSupplierPayment } from '../ap/supplierPaymentWorkflowService';
import type { PostingActorOpts } from '../gl/journalEntryMeta';

export type PaymentKind = 'customer' | 'supplier';

export interface VoidPaymentResult {
  paymentId: string;
  paymentNumber: string | null;
  kind: PaymentKind;
  /** Invoices whose `amount_paid` was reduced. */
  invoicesReopened: number;
  /** Total taken back off those invoices. */
  amountUnapplied: number;
  /** The journal that was reversed, when there was one. */
  journalEntryId: string | null;
  /** The bank line returned to `imported`, when the payment settled one. */
  bankTransactionId: string | null;
}

/** Why a void was refused. Distinguished so the caller can word each one. */
export type VoidRefusal =
  | { refusal: 'not_found' }
  | { refusal: 'already_cancelled' }
  | { refusal: 'not_applied'; status: string }
  | { refusal: 'ambiguous_bank_lines'; count: number };

/**
 * The statuses at which a payment's allocations HAVE been added to the
 * invoice's `amount_paid`, and are therefore the statuses it is safe to
 * subtract them at.
 *
 * A `draft` customer payment and a `draft`/`approved` supplier payment already
 * carry allocation ROWS — both create paths insert them up front — but neither
 * has touched `amount_paid`: that happens in `confirmCustomerPayment` and
 * `processSupplierPayment`. Unwinding one would subtract cash the document
 * never applied, out of some OTHER payment's settlement, while the GL control
 * account stands still. Production carries 2 customer and 63 supplier drafts.
 *
 * `voidSupplierPayment` has refused non-`processed` payments for exactly this
 * reason; this path must not be the way around that guard.
 */
const VOIDABLE_STATUSES: Record<PaymentKind, readonly string[]> = {
  customer: ['confirmed', 'reconciled'],
  supplier: ['processed', 'reconciled'],
};

export function isVoidRefusal(v: VoidPaymentResult | VoidRefusal): v is VoidRefusal {
  return 'refusal' in v;
}

interface PaymentRow {
  id: string;
  paymentNumber: string | null;
  status: string;
  journalEntryId: string | null;
}

/**
 * Read the payment back UNDER company_id — the only tenant check there is —
 * holding a row lock for the rest of the transaction.
 *
 * The lock is not decoration. The registry's idempotency lock only serialises
 * calls carrying the SAME key, so two `void_receipt` calls on one receipt with
 * different keys would both read `confirmed`, both read the not-yet-deleted
 * allocation rows, and both subtract from `amount_paid` — twice, on an invoice
 * carrying other receipts' cash, which `GREATEST(...,0)` only floors at zero.
 */
async function loadPayment(
  companyId: string,
  kind: PaymentKind,
  paymentId: string,
): Promise<PaymentRow | null> {
  const row = kind === 'customer'
    ? await lockCustomerPaymentForUpdate(companyId, paymentId)
    : await lockSupplierPaymentForUpdate(companyId, paymentId);
  if (!row) return null;
  return {
    id: String(row.id),
    paymentNumber: row.payment_number == null ? null : String(row.payment_number),
    status: String(row.status),
    journalEntryId: row.gl_journal_entry_id == null ? null : String(row.gl_journal_entry_id),
  };
}

/**
 * The bank lines this journal settles.
 *
 * Matched through `gl_journal_lines`, because `matched_journal_line_id` names a
 * LINE and the payment names an ENTRY. Only a line that is still allocated
 * counts: one already returned to `imported` has nothing left to reverse.
 *
 * Returns ALL of them, not the first, because `reverseReconciledTransaction`
 * reverses the journal once and returns exactly ONE bank line to `imported`.
 * Picking one of several would leave the others `allocated` against a journal
 * that no longer exists — invisible to unreconciled listings and unrecoverable,
 * since a later reversal of that journal throws on `reversedAt`. Ten journals
 * in production carry two bank lines each (bank transfers: one entry, two bank
 * legs), none belonging to a payment document — guessing would be the wrong way
 * to be wrong about money.
 */
async function findBankTransactions(
  companyId: string,
  journalEntryId: string,
): Promise<string[]> {
  const rows = (await sql`
    SELECT bt.id
    FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id
      AND jl.company_id = bt.company_id
    WHERE bt.company_id = ${companyId}::UUID
      AND jl.journal_entry_id = ${journalEntryId}::UUID
      AND bt.status IN ('allocated', 'matched', 'reconciled')
    ORDER BY bt.transaction_date, bt.id`) as DbRow[];
  return rows.map((r) => String(r.id));
}

/** The payment's journal id WITHOUT its row lock — only to resolve the bank
 * line so THAT can be locked first (see the header). Nothing is decided from
 * it: status and number are re-read under the lock, a moved journal id is
 * caught at the call site. `undefined` = no such row for this tenant. */
async function peekPaymentJournal(
  companyId: string, kind: PaymentKind, paymentId: string,
): Promise<string | null | undefined> {
  const rows = (kind === 'customer'
    ? await sql`SELECT gl_journal_entry_id FROM customer_payments
        WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID`
    : await sql`SELECT gl_journal_entry_id FROM supplier_payments
        WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  if (rows.length === 0) return undefined;
  const id = rows[0]!.gl_journal_entry_id;
  return id == null ? null : String(id);
}

export interface VoidPaymentOptions extends PostingActorOpts {intentId?:string;approvalId?:string;reversalDate?:string;reason?:string}
/** Owned active allocations describe this operation's result; historical inverse rows never count twice. */
async function applicationTotals(companyId:string,kind:PaymentKind,paymentId:string){
 const rows=kind==='customer'?await sql`SELECT count(DISTINCT a.invoice_id)::int AS count,COALESCE(sum(a.amount_allocated),0)::text AS amount
  FROM customer_payment_allocations a JOIN customer_payments p ON p.id=a.payment_id
  WHERE p.company_id=${companyId}::uuid AND p.id=${paymentId}::uuid AND a.reversed_at IS NULL`
  :await sql`SELECT count(DISTINCT a.invoice_id)::int AS count,COALESCE(sum(a.amount_allocated),0)::text AS amount
  FROM payment_allocations a JOIN supplier_payments p ON p.id=a.payment_id
  WHERE p.company_id=${companyId}::uuid AND p.id=${paymentId}::uuid AND a.reversed_at IS NULL`;
 const row=rows[0] as {count:number;amount:string};return{invoicesReopened:row.count,amountUnapplied:Number(row.amount)};
}
export async function voidPaymentDocument(companyId:string,kind:PaymentKind,paymentId:string,userId:string,
 opts?:VoidPaymentOptions):Promise<VoidPaymentResult|VoidRefusal>{
 const ctx=requireControlTx();
 if(ctx.principal.companyId!==companyId||ctx.principal.personId!==userId)throw new Error('Control transaction actor does not match payment void');
 await assertEffectivePermission(ctx,'write:invoices');await assertEffectivePermission(ctx,'write:post');
 return withSavepoint('payment_document_void',async()=>{
  // LOCK ORDER: bank line, then payment — see the header. Locking the payment
  // first is the inverse of `reverseReconciledTransaction` and deadlocks.
  const peekedJournalId=await peekPaymentJournal(companyId,kind,paymentId);
  if(peekedJournalId===undefined)return{refusal:'not_found'};
  const bankLines=peekedJournalId?await findBankTransactions(companyId,peekedJournalId):[];
  if(bankLines.length>1)return{refusal:'ambiguous_bank_lines',count:bankLines.length};
  const bankTransactionId=bankLines[0]??null;
  // A no-op re-lock for `reverseReconciledTransaction` below — one statement,
  // and it fixes the order for the pair.
  if(bankTransactionId)await lockBankTransactionForUpdate(companyId,bankTransactionId);
  const payment=await loadPayment(companyId,kind,paymentId);
  if(!payment)return{refusal:'not_found'};
  if(payment.status==='cancelled')return{refusal:'already_cancelled'};
  if(!VOIDABLE_STATUSES[kind].includes(payment.status))return{refusal:'not_applied',status:payment.status};
  if(payment.journalEntryId!==peekedJournalId){
   // `gl_journal_entry_id` is written once, when the payment posts, and never
   // reassigned — so the row posted between the peek and the lock and the line
   // locked above is the wrong one. Nothing has been written and the retry
   // succeeds, so this is a TYPED retryable refusal, not a bare `Error`.
   throw new PaymentPostedDuringVoidError(paymentId);
  }
  if(bankTransactionId){
   await assertBankPaymentInverseIdentity(ctx,kind,payment.id,bankTransactionId,payment.journalEntryId!);
   const result=await reverseReconciledTransaction(companyId,bankTransactionId,userId,opts);
   return{paymentId:payment.id,paymentNumber:payment.paymentNumber,kind,invoicesReopened:result.invoicesReopened,
    amountUnapplied:result.amountUnapplied,journalEntryId:payment.journalEntryId,bankTransactionId};
  }
  const totals=await applicationTotals(companyId,kind,payment.id);
  if(kind==='customer')await cancelCustomerPayment(companyId,payment.id,userId,opts?.reason,opts);
  else await voidSupplierPayment(companyId,payment.id,userId,opts);
  return{paymentId:payment.id,paymentNumber:payment.paymentNumber,kind,...totals,journalEntryId:payment.journalEntryId,bankTransactionId:null};
 });
}
