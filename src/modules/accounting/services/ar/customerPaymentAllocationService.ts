import {assertCashApplicationsUnapplied} from '../shared/cashApplicationCancellation';
/**
 * Customer Payment Allocation Service
 * GL posting for customer invoices and payment confirmation/cancellation logic.
 * Extracted from customerPaymentService.ts for file-size compliance.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '../gl/journalEntryService';
import { defaultHumanMeta, type PostingActorOpts } from '../gl/journalEntryMeta';
import Decimal from 'decimal.js';
import {resolveArAccounts} from '../controls/arControlAccounts';
import {lockArPaymentSources} from '../controls/arSourceMaterial';
import {registerGeneratedJournal} from '../controls/generatedJournalPermit';
import type {ArParentControl} from './customerInvoiceFinancialEffect';
import {mutateArInvoiceBalance} from './arInvoiceBalanceEffect';
import { getCustomerPaymentById } from './customerPaymentService';
import type { CustomerPayment } from '../../types/ar.types';
import type { JournalLineInput } from '../../types/gl.types';

import {approveCustomerInvoice} from './customerInvoiceApprovalService';
import {runArControlled,requireArControl,type ArApprovalOptions} from './arControlBoundary';
type Row = DbRow;

/**
 * @param opts.postingAgent Stamp for the DR Bank / CR AR journal this posts.
 *   Optional and last-positional so every existing caller keeps its current
 *   `human:<userId>` attribution; only callers that are NOT a human clicking
 *   Confirm (the MCP settle_by_contra tool) pass it. Without it
 *   `createJournalEntry` falls back to `defaultHumanMeta(userId)`, which
 *   affirmatively claims the token owner made the entry by hand and hides it
 *   from `list_agent_postings`. Mirrors postCustomerInvoiceToGL.
 */
async function confirmCustomerPaymentEffect(
  companyId: string,
  id: string,
  userId: string,
  opts: PostingActorOpts|undefined,
  parentControl:ArParentControl,
): Promise<CustomerPayment> {
  try {
    const payment = await getCustomerPaymentById(companyId, id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    if (payment.status !== 'draft') throw new Error(`Cannot confirm payment with status: ${payment.status}`);

    // Auto-post GL: DR Bank, CR Accounts Receivable
    const ctx=requireArControl(companyId,userId),data=await lockArPaymentSources(ctx,id);
    for(const allocation of data.allocations){
      if(!allocation.invoice_journal_id||!['approved','sent','partially_paid','partial','paid'].includes(String(allocation.invoice_status)))throw new Error('Receipt allocation requires a posted invoice');
      const [invoiceJournal]=await ctx.sql`SELECT status,reversed_at FROM gl_journal_entries WHERE company_id=${companyId}::uuid AND id=${String(allocation.invoice_journal_id)}::uuid FOR SHARE` as Array<{status:string;reversed_at:unknown}>;
      if(!invoiceJournal||invoiceJournal.status!=='posted'||invoiceJournal.reversed_at)throw new Error('Receipt allocation requires a live posted invoice journal');
      if(allocation.invoice_status==='cancelled'||new Decimal(String(allocation.invoice_total)).sub(String(allocation.invoice_paid)).lt(String(allocation.amount_allocated)))throw new Error('Payment allocation exceeds current invoice balance');
    }
    const accounts=await resolveArAccounts(ctx,payment.bankAccountId?['receivable']:['receivable','bank'],payment.bankAccountId?[payment.bankAccountId]:[]);
    const arAccount=accounts.chosen.receivable!,bankAccount=payment.bankAccountId?accounts.explicit[0]!:accounts.chosen.bank!;

    const lines: JournalLineInput[] = [
      { glAccountId: String(bankAccount.id), debit: payment.totalAmount, credit: 0,
        description: `Customer payment ${payment.paymentNumber}` },
      { glAccountId: arAccount.id, debit: 0, credit: payment.totalAmount,
        description: `Customer payment ${payment.paymentNumber}` },
    ];

    const je = await createJournalEntry(companyId, {
      entryDate: parentControl.permit.accountingDate,
      description: `Customer payment ${payment.paymentNumber}`,
      source: 'auto_payment',
      sourceRecordId: id,
      lines,
    }, userId, opts?.postingAgent ? { postingAgent: opts.postingAgent } : defaultHumanMeta(userId));
    await registerGeneratedJournal(ctx,parentControl,je.id,'journal.post');
    await postJournalEntry(companyId,je.id,userId,{parentControl});

    // Update invoice balances and mark payment confirmed — runs on the ALS-bound
    // connection so the outer withAuth transaction provides atomicity.
    for (const alloc of payment.allocations) {
      const newPaid = alloc.amountAllocated;
      await mutateArInvoiceBalance(ctx,alloc.invoiceId,parentControl,'payment_applied',()=>sql`
        UPDATE customer_invoices
        SET amount_paid = amount_paid + ${newPaid},
            status = CASE
              WHEN (total_amount - (amount_paid + ${newPaid})) <= 0.01 THEN 'paid'
              WHEN (amount_paid + ${newPaid}) > 0 THEN 'partially_paid'
              ELSE status
            END,
            paid_at = CASE
              WHEN (total_amount - (amount_paid + ${newPaid})) <= 0.01 THEN NOW()
              ELSE paid_at
            END
        WHERE id = ${alloc.invoiceId}::UUID AND company_id = ${companyId}::UUID
      `);
    }

    const updatedRows = (await sql`
      UPDATE customer_payments
      SET status = 'confirmed', confirmed_by = ${userId}::UUID, confirmed_at = NOW(),
          gl_journal_entry_id = ${je.id}::UUID
      WHERE id = ${id} AND company_id = ${companyId}::UUID RETURNING *
    `) as Row[];
    const updated = updatedRows[0] as Row;

    log.info('Confirmed customer payment', { id, journalEntryId: je.id }, 'accounting');
    return mapPaymentRow(updated);
  } catch (err) {
    log.error('Failed to confirm customer payment', { id, error: err }, 'accounting');
    throw err;
  }
}

async function cancelCustomerPaymentEffect(
  companyId: string,
  id: string,
  userId: string,
  reason: string|undefined,
  parentControl:ArParentControl,
): Promise<CustomerPayment> {
  try {
    const payment = await getCustomerPaymentById(companyId, id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    if (payment.status !== 'confirmed') {
      throw new Error(`Cannot cancel payment with status: ${payment.status}`);
    }

    const ctx=requireArControl(companyId,userId);
    await assertCashApplicationsUnapplied(ctx,id,'customer');
    const data=await lockArPaymentSources(ctx,id);
    for(const allocation of data.allocations.filter(a=>a.reversed_at==null)){
      if(new Decimal(String(allocation.invoice_paid)).lt(String(allocation.amount_allocated)))throw new Error('Invoice balance cannot absorb the receipt cancellation');
    }
    // Reverse GL journal entry
    if (payment.glJournalEntryId) {
      await registerGeneratedJournal(ctx,parentControl,payment.glJournalEntryId,'journal.reverse');
      await reverseJournalEntry(companyId,payment.glJournalEntryId,userId,{parentControl,reversalDate:parentControl.permit.accountingDate});
    }

    // Reverse invoice balances + cancel payment — runs on the ALS-bound
    // connection so the outer withAuth transaction provides atomicity.
    for (const alloc of payment.allocations) {
      await mutateArInvoiceBalance(ctx,alloc.invoiceId,parentControl,'payment_unapplied',()=>sql`
        UPDATE customer_invoices
        SET amount_paid = (amount_paid - ${alloc.amountAllocated}),
            status = CASE
              WHEN (amount_paid - ${alloc.amountAllocated}) <= 0.01 THEN 'approved'
              WHEN (amount_paid - ${alloc.amountAllocated}) < total_amount THEN 'partially_paid'
              ELSE status
            END,
            paid_at = CASE WHEN (amount_paid - ${alloc.amountAllocated}) <= 0.01 THEN NULL ELSE paid_at END
        WHERE id = ${alloc.invoiceId}::UUID AND company_id = ${companyId}
      `);
    }

    const cancelNote = reason ? ` [CANCELLED: ${reason}]` : ' [CANCELLED]';
    const updated = (await sql`
      UPDATE customer_payments
      SET status = 'cancelled',
          description = COALESCE(description, '') || ${cancelNote}
      WHERE id = ${id} AND company_id = ${companyId} RETURNING *
    `) as Row[];

    log.info('Cancelled customer payment', { id, reason }, 'accounting');
    return mapPaymentRow(updated[0]!);
  } catch (err) {
    log.error('Failed to cancel customer payment', { id, error: err }, 'accounting');
    throw err;
  }
}

/**
 * @param opts.postingAgent Stamp for the AR journal this posts. Optional and
 *   last-positional so every existing caller keeps its current
 *   `human:<userId>` attribution; only callers that are NOT a human clicking
 *   Approve (the MCP finalize_invoice tool) pass it. Mirrors the
 *   reverseJournalEntry / reverseReconciledTransaction opts pattern.
 */
export async function postCustomerInvoiceToGL(companyId:string,invoiceId:string,userId:string,opts?:PostingActorOpts&ArApprovalOptions&{historicalImport?:boolean}):Promise<string>{
 if(opts?.historicalImport)throw new Error('Historical import requires an explicit persisted import authorization');
 const result=await approveCustomerInvoice(companyId,invoiceId,userId,opts);
 if(!result.glJournalEntryId)throw new Error('Customer invoice journal was not posted');return result.glJournalEntryId;
}

// ── Private mapper ────────────────────────────────────────────────────────────
import type { CustomerPaymentStatus } from '../../types/ar.types';

function mapPaymentRow(row: Row): CustomerPayment {
  return {
    id: String(row.id),
    paymentNumber: row.payment_number ? String(row.payment_number) : '',
    clientId: String(row.client_id),
    paymentDate: fmtDate(row.payment_date),
    totalAmount: Number(row.total_amount),
    paymentMethod: String(row.payment_method) as CustomerPayment['paymentMethod'],
    bankReference: row.bank_reference ? String(row.bank_reference) : undefined,
    bankAccountId: row.bank_account_id ? String(row.bank_account_id) : undefined,
    description: row.description ? String(row.description) : undefined,
    status: String(row.status) as CustomerPaymentStatus,
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    createdBy: String(row.created_by),
    confirmedBy: row.confirmed_by ? String(row.confirmed_by) : undefined,
    confirmedAt: row.confirmed_at ? String(row.confirmed_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    clientName: row.client_name ? String(row.client_name) : undefined,
    allocatedAmount: row.allocated_amount !== undefined ? Number(row.allocated_amount) : 0,
  };
}

export async function confirmCustomerPayment(companyId:string,id:string,userId:string,opts?:PostingActorOpts&ArApprovalOptions):Promise<CustomerPayment>{
 const parent={entityType:'customer_payment',entityId:id,operation:'customer_payment.confirm'} as const;
 return runArControlled(companyId,userId,parent,opts,permit=>confirmCustomerPaymentEffect(companyId,id,userId,opts,{permit,parent}));
}
export async function cancelCustomerPayment(companyId:string,id:string,userId:string,reason?:string,opts?:ArApprovalOptions&{reversalDate?:string}):Promise<CustomerPayment>{
 const parent={entityType:'customer_payment',entityId:id,operation:'customer_payment.cancel',...(opts?.reversalDate===undefined?{}:{reversalDate:opts.reversalDate})} as const;
 return runArControlled(companyId,userId,parent,opts,permit=>cancelCustomerPaymentEffect(companyId,id,userId,reason,{permit,parent}));
}
