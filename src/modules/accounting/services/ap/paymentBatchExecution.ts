import Decimal from 'decimal.js';
import {createJournalEntry,postJournalEntry} from '../gl/journalEntryService';
import {registerGeneratedJournal} from '../controls/generatedJournalPermit';
import type {ControlledEffectPermit} from '../controls/approvalExecutionService';
import {assertControlledEffectPermit} from '../controls/approvalExecutionService';
import {requireControlTx} from '../controls/context';
import {loadPreparedBatch,loadBatchBankAccount} from './paymentBatchSource';
import {recordBatchEntity} from './batchPaymentWriteService';
import {selectApSystemAccount} from './apControlAccounts';
/** One aggregate GL effect and all settlement records share the parent approval transaction. */
export async function executePaymentBatchEffect(batchId:string,permit:ControlledEffectPermit):Promise<{batchId:string;journalEntryId:string}>{
 const ctx=requireControlTx(),company=ctx.principal.companyId;
 const parent={entityType:'supplier_payment_batch',entityId:batchId,operation:'supplier_payment_batch.process' as const};
 assertControlledEffectPermit(ctx,permit,parent);
 const material=await loadPreparedBatch(ctx,batchId);
 if(material.batch.status!=='approved'||material.payments.some(p=>p.payment.status!=='approved'))throw new Error('Approved batch and payments required');
 const bank=await loadBatchBankAccount(ctx,material.batch.bank_account_id);
 const accounts=await ctx.sql`SELECT id,account_type,account_subtype,is_active,is_system_account FROM gl_accounts
  WHERE company_id=${company}::uuid AND account_subtype='payable' AND is_system_account=true AND is_active=true ORDER BY id FOR SHARE` as Array<Record<string,unknown>&{id:string}>;
 const payable=selectApSystemAccount(accounts,'payable');
 const allocations=material.payments.flatMap(p=>p.facts.allocations.map(a=>({...a,supplierId:p.payment.supplier_id}))).sort((a,b)=>a.invoiceId<b.invoiceId?-1:1);
 if(new Set(allocations.map(a=>a.invoiceId)).size!==allocations.length)throw new Error('Duplicate batch invoice');
 const invoices=new Map<string,Record<string,unknown>>();
 for(const allocation of allocations){
  const [invoice]=await ctx.sql`SELECT * FROM supplier_invoices WHERE company_id=${company}::uuid
   AND id=${allocation.invoiceId}::uuid AND supplier_id=${allocation.supplierId}::uuid FOR UPDATE` as Record<string,unknown>[];
  if(!invoice||!['approved','posted','partially_paid'].includes(String(invoice.status))
   ||new Decimal(String(invoice.amount_paid)).add(allocation.amount).gt(String(invoice.total_amount)))throw new Error('Batch invoice no longer payable');
  invoices.set(allocation.invoiceId,invoice);
 }
 const amount=Number(material.amount);
 const journal=await createJournalEntry(company,{entryDate:material.batch.batch_date,description:`Supplier batch payment ${material.batch.batch_number}`,
  source:'auto_batch_payment',sourceRecordId:batchId,lines:[{glAccountId:payable.id,debit:amount,credit:0},{glAccountId:bank.id,debit:0,credit:amount}]},ctx.principal.personId);
 const parentControl={parent,permit};await registerGeneratedJournal(ctx,parentControl,journal.id,'journal.post');
 await postJournalEntry(company,journal.id,ctx.principal.personId,{parentControl});
 for(const allocation of allocations){
  const before=invoices.get(allocation.invoiceId)!;
  const [after]=await ctx.sql`UPDATE supplier_invoices SET amount_paid=amount_paid+${allocation.amount}::numeric,
   status=CASE WHEN total_amount-amount_paid-${allocation.amount}::numeric<=0.01 THEN 'paid' ELSE 'partially_paid' END
   WHERE company_id=${company}::uuid AND id=${allocation.invoiceId}::uuid RETURNING *` as Record<string,unknown>[];
  if(!after)throw new Error('Batch invoice disappeared');await recordBatchEntity(ctx,'supplier_invoice',before,after,'payment_applied',material.batch.batch_date);
 }
 for(const payment of material.payments){
  const [before]=await ctx.sql`SELECT * FROM supplier_payments WHERE company_id=${company}::uuid AND id=${payment.payment.id}::uuid` as Record<string,unknown>[];
  const [after]=await ctx.sql`UPDATE supplier_payments SET status='processed',processed_at=clock_timestamp(),gl_journal_entry_id=${journal.id}::uuid
   WHERE company_id=${company}::uuid AND id=${payment.payment.id}::uuid RETURNING *` as Record<string,unknown>[];
  if(!before||!after)throw new Error('Batch payment disappeared');await recordBatchEntity(ctx,'supplier_payment',before,after,'supplier_payment.process');
 }
 await ctx.sql`UPDATE supplier_payment_batches SET status='processed',processed_by=${ctx.principal.personId}::uuid,
  processed_at=clock_timestamp(),gl_journal_entry_id=${journal.id}::uuid WHERE company_id=${company}::uuid AND id=${batchId}::uuid`;
 return{batchId,journalEntryId:journal.id};
}
