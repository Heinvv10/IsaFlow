import {isBankAllocationRefund} from './bankAllocationPlan';
import {recomputeInvoiceStatus} from '../ar/invoiceStatusRecompute';
import type {PostingActorOpts} from '../gl/journalEntryMeta';
import {bankAllocationActor} from './bankAllocationActor';
import Decimal from 'decimal.js';
const D=Decimal.clone({precision:80});
import type {ControlTx} from '../controls/contracts';
import {assertControlledEffectPermit,type ControlledEffectPermit} from '../controls/approvalExecutionService';
import {registerGeneratedJournal} from '../controls/generatedJournalPermit';
import {reverseJournalEntry} from '../gl/journalEntryPostingService';
import {loadBankAllocationReversal} from './bankAllocationReversalMaterial';
import {assertOriginalAllocationReversible} from './bankAllocationReversalSources';
import {recordBankAllocationChild} from './bankAllocationChildEffect';
type Row=Record<string,unknown>;
export async function executeBankAllocationReversalEffect(ctx:ControlTx,intentId:string,permit:ControlledEffectPermit,options?:PostingActorOpts){
 const parent={entityType:'bank_allocation_reversal_intent',entityId:intentId,operation:'bank_allocation.reverse' as const};
 assertControlledEffectPermit(ctx,permit,parent);
 const state=await loadBankAllocationReversal(ctx,intentId);
 if(state.kind==='legacy')return executeLegacyProvisionalReversalEffect(ctx,intentId,permit,state,options);
 const original=await assertOriginalAllocationReversible(ctx,String(state.intent.original_intent_id));
 if(state.effect||state.periods.length!==1||state.periods[0]!.status!=='open')throw new Error('Open unexecuted bank reversal required');
 const parentControl={parent,permit};await registerGeneratedJournal(ctx,parentControl,String(original.journal.id),'journal.reverse');
 const contra=await reverseJournalEntry(ctx.principal.companyId,String(original.journal.id),ctx.principal.personId,{...bankAllocationActor(ctx.principal,options),parentControl,reversalDate:permit.accountingDate});
 const company=ctx.principal.companyId;
 if('applications' in original.plan&&!isBankAllocationRefund(original.plan.kind,String(original.sources.bank.amount))){
  for(const item of original.sources.invoices){
   const before=item.invoice as Row,allocation=item.allocation as {invoiceId:string;amount:string};
   const updates=original.plan.kind==='customer'?await ctx.sql`UPDATE customer_invoices SET amount_paid=amount_paid-${allocation.amount}::numeric
    WHERE company_id=${company}::uuid AND id=${allocation.invoiceId}::uuid AND amount_paid>=${allocation.amount}::numeric RETURNING id`
    :await ctx.sql`UPDATE supplier_invoices SET amount_paid=amount_paid-${allocation.amount}::numeric
    WHERE company_id=${company}::uuid AND id=${allocation.invoiceId}::uuid AND amount_paid>=${allocation.amount}::numeric RETURNING id`;
   if(!(updates as Row[])[0])throw new Error('Allocation reversal invoice balance changed');
   await recomputeInvoiceStatus(company,original.plan.kind,allocation.invoiceId);
   const settled=original.plan.kind==='customer'?await ctx.sql`SELECT * FROM customer_invoices WHERE company_id=${company}::uuid AND id=${allocation.invoiceId}::uuid`
    :await ctx.sql`SELECT * FROM supplier_invoices WHERE company_id=${company}::uuid AND id=${allocation.invoiceId}::uuid`;
   const after=(settled as Row[])[0];if(!after)throw new Error('Allocation reversal invoice disappeared');
   await recordBankAllocationChild(ctx,permit,original.plan.kind==='customer'?'customer_invoice':'supplier_invoice',before,after,'bank_allocation.unapplied');
  }
  const before=(original.plan.kind==='customer'?original.sources.receipts:original.sources.disbursements).find(p=>p.id===original.receipt.result.paymentId)!;
  const updates=original.plan.kind==='customer'?await ctx.sql`UPDATE customer_payments SET status='cancelled' WHERE company_id=${company}::uuid AND id=${before.id}::uuid RETURNING *`
   :await ctx.sql`UPDATE supplier_payments SET status='cancelled' WHERE company_id=${company}::uuid AND id=${before.id}::uuid RETURNING *`;
  const after=(updates as Row[])[0];if(!after)throw new Error('Allocation reversal payment disappeared');
  await recordBankAllocationChild(ctx,permit,original.plan.kind==='customer'?'customer_payment':'supplier_payment',before,after,'bank_allocation.payment_cancelled');
 }
 for(const before of original.transfer?.banks??[original.sources.bank]){
 // provisional_je_id with them: a reversed provisional entry no longer has one, and the column is already NULL on
 // every other allocation.
 const [after]=await ctx.sql`UPDATE bank_transactions SET status='imported',matched_journal_line_id=NULL,provisional_je_id=NULL,reconciliation_id=NULL,linked_po_id=NULL,
  transfer_journal_entry_id=NULL,counterparty_account_id=NULL,allocation_type=NULL,allocated_entity_name=NULL,allocation_rule_id=NULL,allocation_rule_name=NULL,allocation_batch_id=NULL,updated_at=clock_timestamp()
  WHERE company_id=${company}::uuid AND id=${before.id}::uuid RETURNING *` as Row[];
 if(!after)throw new Error('Allocation reversal bank disappeared');
 await recordBankAllocationChild(ctx,permit,'bank_transaction',before,after,'bank_allocation.reversed');
 }
 const observed=await loadBankAllocationReversal(ctx,intentId,permit);
 return{intentId,bankTransactionId:original.plan.bankTransactionId,originalJournalEntryId:String(original.journal.id),reversalJournalEntryId:contra.id,
  afterFingerprint:observed.fingerprint,invoicesReopened:original.sources.invoices.length,
  amountUnapplied:'applications' in original.plan?Number(original.plan.applications.reduce((sum,a)=>sum.add(a.amount),new D(0)).toFixed()):0,paymentsCancelled:original.receipt.result.paymentId?1:0};
}
/**
 * Reversing a provisional entry proven from the data: contra the journal under this permit, and return the bank line
 * to the review queue. There is no payment and no invoice application to walk back — the proof refuses a journal that
 * has any — and no original intent to unwind, which is the whole difference from the receipted path above.
 */
async function executeLegacyProvisionalReversalEffect(ctx:ControlTx,intentId:string,permit:ControlledEffectPermit,
 state:Extract<Awaited<ReturnType<typeof loadBankAllocationReversal>>,{kind:'legacy'}>,options?:PostingActorOpts){
 const parent={entityType:'bank_allocation_reversal_intent',entityId:intentId,operation:'bank_allocation.reverse' as const};
 assertControlledEffectPermit(ctx,permit,parent);
 const legacy=state.legacy;
 if(!legacy||state.effect||state.periods.length!==1||state.periods[0]!.status!=='open')throw new Error('Open unexecuted bank reversal required');
 const company=ctx.principal.companyId,journalId=String(legacy.journal.id);
 const parentControl={parent,permit};await registerGeneratedJournal(ctx,parentControl,journalId,'journal.reverse');
 const contra=await reverseJournalEntry(company,journalId,ctx.principal.personId,{...bankAllocationActor(ctx.principal,options),parentControl,reversalDate:permit.accountingDate});
 const [after]=await ctx.sql`UPDATE bank_transactions SET status='imported',provisional_je_id=NULL,matched_journal_line_id=NULL,
  reconciliation_id=NULL,allocation_type=NULL,allocated_entity_name=NULL,allocation_rule_id=NULL,allocation_rule_name=NULL,allocation_batch_id=NULL,
  updated_at=clock_timestamp() WHERE company_id=${company}::uuid AND id=${String(legacy.bank.id)}::uuid AND status='provisional' RETURNING *` as Row[];
 if(!after)throw new Error('Allocation reversal bank disappeared');
 await recordBankAllocationChild(ctx,permit,'bank_transaction',legacy.bank,after,'bank_allocation.reversed');
 const observed=await loadBankAllocationReversal(ctx,intentId,permit);
 return{intentId,bankTransactionId:String(legacy.bank.id),originalJournalEntryId:journalId,reversalJournalEntryId:contra.id,
  afterFingerprint:observed.fingerprint,invoicesReopened:0,amountUnapplied:0,paymentsCancelled:0};
}
