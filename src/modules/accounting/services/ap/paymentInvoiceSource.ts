import {createHash} from 'node:crypto';
import {canonicalJson} from '../controls/canonical';
import {readControlEntityVersion} from '../controls/operationVersions';
import type {ControlTx} from '../controls/contracts';
import type {PaymentSourceRow} from './paymentReleaseSource';
import {normalizePaymentInvoiceState} from './paymentInvoiceBinding';
type Row=Record<string,unknown>;
async function journalSource(ctx:ControlTx,id:string){
 const company=ctx.principal.companyId;
 const [journal]=await ctx.sql`SELECT * FROM gl_journal_entries WHERE company_id=${company}::uuid AND id=${id}::uuid FOR SHARE` as Row[];
 if(!journal)throw new Error('Payment source journal unavailable');
 const lines=await ctx.sql`SELECT l.*,a.account_type,a.account_subtype FROM gl_journal_lines l
  JOIN gl_accounts a ON a.company_id=l.company_id AND a.id=l.gl_account_id
  WHERE l.company_id=${company}::uuid AND l.journal_entry_id=${id}::uuid ORDER BY l.id LIMIT 1001 FOR SHARE OF l,a` as Row[];
 if(!lines.length||lines.length>1000)throw new Error('Payment source journal population unavailable');
 const [sum]=await ctx.sql`SELECT sum(l.debit)::text AS debit,sum(l.credit)::text AS credit,
  COALESCE(sum(CASE WHEN a.account_subtype='payable' AND a.account_type='liability' THEN l.credit-l.debit ELSE 0 END),0)::text AS payable_credit
  FROM gl_journal_lines l JOIN gl_accounts a ON a.company_id=l.company_id AND a.id=l.gl_account_id
  WHERE l.company_id=${company}::uuid AND l.journal_entry_id=${id}::uuid` as Row[];
 return{journal:{...journal,...sum},lines};
}
async function ownSettlement(ctx:ControlTx,payment:PaymentSourceRow){
 if(payment.status!=='processed'){
  if(payment.gl_journal_entry_id)throw new Error('Unprocessed payment already has a journal');
  return null;
 }
 if(!payment.gl_journal_entry_id)throw new Error('Processed payment has no owned settlement journal');
 const source=await journalSource(ctx,payment.gl_journal_entry_id),journal=source.journal;
 const entityType=payment.batch_id?'supplier_payment_batch':'supplier_payment';
 const entityId=payment.batch_id??payment.id,operation=payment.batch_id?'supplier_payment_batch.process':'supplier_payment.process';
 if(journal.status!=='posted'||journal.reversed_at||journal.source_record_id!==entityId
  ||journal.source!==(payment.batch_id?'auto_batch_payment':'auto_supplier_payment'))throw new Error('Payment settlement journal changed');
 const [effect]=await ctx.sql`SELECT id,result FROM control_operation_effects WHERE company_id=${ctx.principal.companyId}::uuid
  AND entity_type=${entityType} AND entity_id=${entityId} AND operation=${operation}
  AND COALESCE(result->>'journalEntryId',result->>'glJournalEntryId')=${payment.gl_journal_entry_id} ORDER BY committed_at DESC LIMIT 1` as Row[];
 if(!effect)throw new Error('Payment settlement has no committed control receipt');
 if(payment.batch_id){
  const [batch]=await ctx.sql`SELECT status,gl_journal_entry_id FROM supplier_payment_batches WHERE company_id=${ctx.principal.companyId}::uuid AND id=${payment.batch_id}::uuid FOR UPDATE` as Row[];
  if(batch?.status!=='processed'||batch.gl_journal_entry_id!==payment.gl_journal_entry_id)throw new Error('Payment aggregate settlement changed');
 }
 return{...source,effectId:effect.id};
}
/** Locks current invoices, source journals and source lines; full observations are bound at release preparation. */
export async function loadPaymentInvoiceSources(ctx:ControlTx,payment:PaymentSourceRow,allocations:readonly {invoice_id:string;amount_allocated:string}[]){
 const settlement=await ownSettlement(ctx,payment),normal=[],current=[];
 for(const allocation of allocations){
  const [invoice]=await ctx.sql`SELECT * FROM supplier_invoices WHERE company_id=${ctx.principal.companyId}::uuid
   AND id=${allocation.invoice_id}::uuid AND supplier_id=${payment.supplier_id}::uuid FOR UPDATE` as Row[];
  if(!invoice?.gl_journal_entry_id)throw new Error('Payment invoice is not posted');
  const source=await journalSource(ctx,String(invoice.gl_journal_entry_id));
  const normalized=normalizePaymentInvoiceState(invoice,source.journal,allocation.amount_allocated,settlement!==null);
  const lines=await ctx.sql`SELECT i.* FROM supplier_invoice_items i JOIN supplier_invoices si ON si.id=i.supplier_invoice_id
   WHERE si.company_id=${ctx.principal.companyId}::uuid AND si.id=${allocation.invoice_id}::uuid ORDER BY i.id LIMIT 1001 FOR SHARE OF i` as Row[];
  if(!lines.length||lines.length>1000)throw new Error('Payment invoice line population unavailable');
  const versions={invoice:await readControlEntityVersion(ctx,{entityType:'supplier_invoice',entityId:allocation.invoice_id}),
   journal:await readControlEntityVersion(ctx,{entityType:'journal_entry',entityId:String(invoice.gl_journal_entry_id)})};
  normal.push({...normalized,subtotal:invoice.subtotal,taxAmount:invoice.tax_amount,lines,journal:source});
  current.push({invoice,invoiceLines:lines,journalSource:source,versions});
 }
 return{normal,currentFingerprint:createHash('sha256').update(canonicalJson({current,settlement,paymentStatus:payment.status})).digest('hex')};
}
