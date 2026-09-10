import Decimal from 'decimal.js';
import {fmtDate} from '@/lib/fmtDate';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../controls/canonical';
import {readControlEntityVersion} from '../controls/operationVersions';
import {loadIntentReceipt} from '../controls/intentIdentity';
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
 if(journal.status!=='posted'||journal.reversed_at||journal.source_record_id!==entityId||fmtDate(journal.entry_date as string|Date)!==payment.payment_date
  ||journal.source!==(payment.batch_id?'auto_batch_payment':'auto_supplier_payment'))throw new Error('Payment settlement journal changed');
 // A receipt written before entity_id normalization keeps its original spelling.
 const effect=await loadIntentReceipt<Record<string,unknown>>(ctx,{entityType,entityId,operation});
 if(!effect||(effect.result.journalEntryId??effect.result.glJournalEntryId)!==payment.gl_journal_entry_id)throw new Error('Payment settlement has no committed control receipt');
 let settlementAmount=payment.total_amount,bankId=payment.bank_account_id;
 if(payment.batch_id){
  const [batch]=await ctx.sql`SELECT status,gl_journal_entry_id,total_amount,bank_account_id,payment_count FROM supplier_payment_batches WHERE company_id=${ctx.principal.companyId}::uuid AND id=${payment.batch_id}::uuid FOR UPDATE` as Row[];
  if(batch?.status!=='processed'||batch.gl_journal_entry_id!==payment.gl_journal_entry_id)throw new Error('Payment aggregate settlement changed');
  settlementAmount=String(batch.total_amount);bankId=String(batch.bank_account_id);
  const population=await ctx.sql`SELECT id,total_amount,status,gl_journal_entry_id,bank_account_id FROM supplier_payments
   WHERE company_id=${ctx.principal.companyId}::uuid AND batch_id=${payment.batch_id}::uuid ORDER BY id LIMIT 101 FOR SHARE` as Row[];
  const D=Decimal.clone({precision:80});
  if(population.length!==Number(batch.payment_count)||population.length>100
   ||population.some(p=>p.status!=='processed'||p.gl_journal_entry_id!==payment.gl_journal_entry_id||p.bank_account_id!==bankId)
   ||!population.reduce((sum,p)=>sum.add(String(p.total_amount)),new D(0)).eq(settlementAmount))throw new Error('Payment settlement population changed');
 }
 const D=Decimal.clone({precision:80}),total=new D(settlementAmount);
 const payable=source.lines.filter(line=>line.account_type==='liability'&&line.account_subtype==='payable');
 const bank=source.lines.filter(line=>line.gl_account_id===bankId&&line.account_type==='asset'&&line.account_subtype==='bank');
 if(!total.gt(0)||source.lines.length!==2||payable.length!==1||bank.length!==1
  ||!new D(String(journal.debit)).eq(total)||!new D(String(journal.credit)).eq(total)||!new D(String(journal.payable_credit)).eq(total.neg())
  ||!new D(String(payable[0]!.debit)).eq(total)||!new D(String(payable[0]!.credit)).isZero()
  ||!new D(String(bank[0]!.credit)).eq(total)||!new D(String(bank[0]!.debit)).isZero())throw new Error('Payment settlement journal does not reconcile');
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
